use super::*;

fn queued_service() -> FirestoreService {
    // Exercise the disk executor without making scheduler assertions depend on
    // filesystem speed. The durable-store integration test below uses real I/O.
    FirestoreService {
        disk_write_queue: Some(Arc::new(tokio::sync::Semaphore::new(1))),
        ..FirestoreService::default()
    }
}

#[tokio::test]
async fn durable_work_does_not_block_the_single_async_worker_or_spawn_per_waiter() {
    let service = queued_service();
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let first_service = service.clone();
    let first = tokio::spawn(async move {
        first_service
            .run_write(move |_| {
                started.send(()).expect("test is waiting");
                wait.recv_timeout(Duration::from_secs(5))
                    .expect("async worker must remain able to release the write");
                Ok(1)
            })
            .await
    });
    ready.await.expect("blocking closure started");
    let second_service = service.clone();
    let second = tokio::spawn(async move { second_service.run_write(|_| Ok(2)).await });
    tokio::task::yield_now().await;
    assert!(
        !second.is_finished(),
        "second write must wait asynchronously"
    );
    assert_eq!(
        service
            .disk_write_queue
            .as_ref()
            .unwrap()
            .available_permits(),
        0
    );
    release.send(()).expect("first closure still waiting");
    assert_eq!(first.await.unwrap().unwrap(), 1);
    assert_eq!(second.await.unwrap().unwrap(), 2);
    assert_eq!(
        service
            .disk_write_queue
            .as_ref()
            .unwrap()
            .available_permits(),
        1
    );
}

#[tokio::test]
async fn disconnected_caller_does_not_release_an_inflight_durable_write() {
    let service = queued_service();
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let first_service = service.clone();
    let first = tokio::spawn(async move {
        first_service
            .run_write(move |_| {
                started.send(()).unwrap();
                wait.recv_timeout(Duration::from_secs(5)).unwrap();
                Ok(())
            })
            .await
    });
    ready.await.unwrap();
    first.abort();
    assert!(first.await.unwrap_err().is_cancelled());
    assert_eq!(
        service
            .disk_write_queue
            .as_ref()
            .unwrap()
            .available_permits(),
        0
    );
    let next_service = service.clone();
    let next = tokio::spawn(async move { next_service.run_write(|_| Ok(3)).await });
    tokio::task::yield_now().await;
    assert!(!next.is_finished());
    release.send(()).unwrap();
    assert_eq!(next.await.unwrap().unwrap(), 3);
}

#[tokio::test]
async fn failed_write_releases_the_queue_without_changing_its_status() {
    let service = queued_service();
    let error = service
        .run_write::<(), _>(|_| Err(Status::failed_precondition("oracle precondition")))
        .await
        .unwrap_err();
    assert_eq!(error.code(), tonic::Code::FailedPrecondition);
    assert_eq!(error.message(), "oracle precondition");
    assert_eq!(service.run_write(|_| Ok(7)).await.unwrap(), 7);
    assert!(FirestoreService::default().disk_write_queue.is_none());
}

#[tokio::test]
async fn cancellation_while_queued_never_starts_the_write() {
    let service = queued_service();
    let queue = Arc::clone(service.disk_write_queue.as_ref().unwrap());
    let held = queue.acquire().await.unwrap();
    let executed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let observed = Arc::clone(&executed);
    let pending = tokio::spawn(async move {
        service
            .run_write(move |_| {
                executed.store(true, Ordering::SeqCst);
                Ok(())
            })
            .await
    });
    tokio::task::yield_now().await;
    pending.abort();
    assert!(pending.await.unwrap_err().is_cancelled());
    drop(held);
    tokio::task::yield_now().await;
    assert!(!observed.load(Ordering::SeqCst));
    assert_eq!(queue.available_permits(), 1);
}

#[tokio::test]
async fn acknowledged_queued_disk_commit_and_stream_write_survive_reopen() {
    let directory = std::env::temp_dir().join(format!(
        "fireside-grpc-write-queue-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&directory).unwrap();
    let database = "projects/demo/databases/(default)";
    let document = |id: &str| proto::Write {
        operation: Some(Operation::Update(proto::Document {
            name: format!("{database}/documents/items/{id}"),
            fields: BTreeMap::from([(
                "value".to_owned(),
                proto::Value {
                    value_type: Some(proto::value::ValueType::IntegerValue(42)),
                },
            )]),
            ..proto::Document::default()
        })),
        ..proto::Write::default()
    };
    {
        let store =
            Store::open_disk(&directory, fireside_core_store::DiskOptions::default()).unwrap();
        assert!(store.is_disk_backed());
        let service = FirestoreService::new(store);
        assert!(service.disk_write_queue.is_some());
        let database_name = decode_database_name(database).unwrap();
        let (commit, stream) = tokio::join!(
            service.commit(Request::new(CommitRequest {
                database: database.to_owned(),
                writes: vec![document("unary")],
                ..CommitRequest::default()
            })),
            service.apply_stream_writes(
                &Authorization::Owner,
                &database_name,
                vec![document("stream")]
            )
        );
        assert_eq!(commit.unwrap().into_inner().write_results.len(), 1);
        assert_eq!(stream.unwrap().write_results.len(), 1);
    }
    {
        let reopened =
            Store::open_disk(&directory, fireside_core_store::DiskOptions::default()).unwrap();
        let snapshot = reopened.snapshot();
        for id in ["unary", "stream"] {
            let key = decode_document_name(&format!("{database}/documents/items/{id}")).unwrap();
            assert!(
                snapshot.get(&key).is_some(),
                "acknowledged write must be durable"
            );
        }
    }
    std::fs::remove_dir_all(directory).unwrap();
}
