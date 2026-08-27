use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use fireside_core_store::{
    CommitError, CommitResult, DatabaseName, Document, DocumentKey, FieldTransform, Snapshot,
    SnapshotError, Store, Timestamp, TransformOperation, Value, Write,
};
use fireside_query_engine::{
    DatabaseEdition, IndexConfigError, QueryDocument, QueryPolicy, aggregate, execute, partition,
};
use tokio_stream::{Stream, iter};
use tonic::{Request, Response, Status};

use crate::codec::{
    DecodedWrite, decode_database_name, decode_document_name, decode_fields, decode_parent,
    decode_read_time, decode_write, encode_document_masked, encode_fields, encode_timestamp,
    encode_value, nested_value,
};
use crate::google::firestore::v1::batch_get_documents_request;
use crate::google::firestore::v1::batch_get_documents_response;
use crate::google::firestore::v1::firestore_server::{Firestore, FirestoreServer};
use crate::google::firestore::v1::get_document_request;
use crate::google::firestore::v1::list_collection_ids_request;
use crate::google::firestore::v1::list_documents_request;
use crate::google::firestore::v1::partition_query_request;
use crate::google::firestore::v1::run_aggregation_query_request;
use crate::google::firestore::v1::run_query_request;
use crate::google::firestore::v1::transaction_options;
use crate::google::firestore::v1::write::Operation;
use crate::google::firestore::v1::{
    self as proto, BatchGetDocumentsRequest, BatchGetDocumentsResponse, BatchWriteRequest,
    BatchWriteResponse, BeginTransactionRequest, BeginTransactionResponse, CommitRequest,
    CommitResponse, CreateDocumentRequest, DeleteDocumentRequest, ExecutePipelineRequest,
    ExecutePipelineResponse, GetDocumentRequest, ListCollectionIdsRequest,
    ListCollectionIdsResponse, ListDocumentsRequest, ListDocumentsResponse, ListenRequest,
    ListenResponse, PartitionQueryRequest, PartitionQueryResponse, RollbackRequest,
    RunAggregationQueryRequest, RunAggregationQueryResponse, RunQueryRequest, RunQueryResponse,
    TransactionOptions, UpdateDocumentRequest, WriteRequest, WriteResponse, WriteResult,
};
use crate::google::rpc;
use crate::query_codec::{decode_aggregation, decode_query, query_status};

pub(crate) type ResponseStream<T> = Pin<Box<dyn Stream<Item = Result<T, Status>> + Send + 'static>>;

/// Handwritten Firestore v1 service adapter over the MVCC store.
#[derive(Clone)]
pub struct FirestoreService {
    store: Store,
    query_policy: QueryPolicy,
    transactions: Arc<Mutex<HashMap<Vec<u8>, TransactionState>>>,
    commit_guard: Arc<Mutex<()>>,
    next_id: Arc<AtomicU64>,
}

impl FirestoreService {
    /// Creates a service backed by an in-memory MVCC store.
    #[must_use]
    pub fn new(store: Store) -> Self {
        Self::new_with_edition(store, DatabaseEdition::Standard)
    }

    /// Creates a service with the selected database-edition query semantics.
    #[must_use]
    pub fn new_with_edition(store: Store, edition: DatabaseEdition) -> Self {
        Self::new_with_query_policy(store, QueryPolicy::new(edition))
    }

    /// Creates a service with shared edition and strict-index query behavior.
    #[must_use]
    pub fn new_with_query_policy(store: Store, query_policy: QueryPolicy) -> Self {
        Self {
            store,
            query_policy,
            transactions: Arc::new(Mutex::new(HashMap::new())),
            commit_guard: Arc::new(Mutex::new(())),
            next_id: Arc::new(AtomicU64::new(1)),
        }
    }

    /// Wraps this adapter in tonic's generated HTTP service.
    #[must_use]
    pub fn into_server(self) -> FirestoreServer<Self> {
        FirestoreServer::new(self)
    }

    /// Returns the underlying store for diagnostics and in-process tests.
    #[must_use]
    pub const fn store(&self) -> &Store {
        &self.store
    }

    fn begin_transaction_inner(
        &self,
        database: DatabaseName,
        options: Option<TransactionOptions>,
    ) -> Result<Vec<u8>, Status> {
        let mut transactions = self.transaction_states();
        let (read_only, snapshot) = match options.and_then(|options| options.mode) {
            None | Some(transaction_options::Mode::ReadWrite(_)) => (false, self.store.snapshot()),
            Some(transaction_options::Mode::ReadOnly(options)) => {
                let snapshot = match options.consistency_selector {
                    None => self.store.snapshot(),
                    Some(transaction_options::read_only::ConsistencySelector::ReadTime(
                        read_time,
                    )) => self
                        .store
                        .snapshot_at_time(decode_read_time(read_time, now())?)
                        .map_err(snapshot_status)?,
                };
                (true, snapshot)
            }
        };
        let sequence = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut token = b"fireside-txn-".to_vec();
        token.extend_from_slice(&sequence.to_be_bytes());
        transactions.insert(
            token.clone(),
            TransactionState {
                database,
                snapshot,
                read_only,
                reads: BTreeMap::new(),
            },
        );
        Ok(token)
    }

    fn snapshot_for_transaction(
        &self,
        database: &DatabaseName,
        token: &[u8],
    ) -> Result<Snapshot, Status> {
        let transactions = self.transaction_states();
        let transaction = transactions
            .get(token)
            .ok_or_else(|| Status::invalid_argument("unknown transaction"))?;
        if &transaction.database != database {
            return Err(Status::invalid_argument(
                "transaction belongs to a different database",
            ));
        }
        Ok(transaction.snapshot.clone())
    }

    fn record_read(&self, token: &[u8], key: &DocumentKey, document: Option<&Document>) {
        if token.is_empty() {
            return;
        }
        if let Some(transaction) = self.transaction_states().get_mut(token) {
            transaction
                .reads
                .entry(key.clone())
                .or_insert_with(|| document.map(Document::update_time));
        }
    }

    fn apply_writes(&self, decoded: &[DecodedWrite]) -> Result<CommitResponse, Status> {
        let writes = decoded
            .iter()
            .map(|decoded| decoded.write.clone())
            .collect::<Vec<_>>();
        let result = self.store.commit(&writes).map_err(commit_status)?;
        let snapshot = self.store.snapshot();
        let write_results = decoded
            .iter()
            .map(|decoded| write_result(decoded, &snapshot, result))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(CommitResponse {
            write_results,
            commit_time: Some(encode_timestamp(result.commit_time)),
        })
    }

    pub(crate) fn apply_stream_writes(
        &self,
        writes: Vec<proto::Write>,
    ) -> Result<CommitResponse, Status> {
        let decoded = writes
            .into_iter()
            .map(decode_write)
            .collect::<Result<Vec<_>, _>>()?;
        let _guard = self.write_lock();
        self.apply_writes(&decoded)
    }

    pub(crate) fn next_stream_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    fn transaction_states(&self) -> MutexGuard<'_, HashMap<Vec<u8>, TransactionState>> {
        self.transactions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn write_lock(&self) -> MutexGuard<'_, ()> {
        self.commit_guard
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl Default for FirestoreService {
    fn default() -> Self {
        Self::new(Store::default())
    }
}

struct TransactionState {
    database: DatabaseName,
    snapshot: Snapshot,
    read_only: bool,
    reads: BTreeMap<DocumentKey, Option<Timestamp>>,
}

#[tonic::async_trait]
impl Firestore for FirestoreService {
    async fn get_document(
        &self,
        request: Request<GetDocumentRequest>,
    ) -> Result<Response<proto::Document>, Status> {
        let request = request.into_inner();
        let key = decode_document_name(&request.name)?;
        let token = match request.consistency_selector {
            None => Vec::new(),
            Some(get_document_request::ConsistencySelector::Transaction(token)) => token,
            Some(get_document_request::ConsistencySelector::ReadTime(read_time)) => {
                let snapshot = self
                    .store
                    .snapshot_at_time(decode_read_time(read_time, now())?)
                    .map_err(snapshot_status)?;
                let document = snapshot
                    .get(&key)
                    .ok_or_else(|| Status::not_found(format!("document not found: {key}")))?;
                return Ok(Response::new(encode_document_masked(
                    &key,
                    &document,
                    request.mask.as_ref(),
                )?));
            }
        };
        let snapshot = if token.is_empty() {
            self.store.snapshot()
        } else {
            self.snapshot_for_transaction(key.database(), &token)?
        };
        let document = snapshot
            .get(&key)
            .ok_or_else(|| Status::not_found(format!("document not found: {key}")))?;
        self.record_read(&token, &key, Some(&document));
        Ok(Response::new(encode_document_masked(
            &key,
            &document,
            request.mask.as_ref(),
        )?))
    }

    async fn list_documents(
        &self,
        request: Request<ListDocumentsRequest>,
    ) -> Result<Response<ListDocumentsResponse>, Status> {
        let request = request.into_inner();
        let (database, parent) = decode_parent(&request.parent)?;
        let (token, historical) = match request.consistency_selector {
            None => (Vec::new(), None),
            Some(list_documents_request::ConsistencySelector::Transaction(token)) => (token, None),
            Some(list_documents_request::ConsistencySelector::ReadTime(read_time)) => (
                Vec::new(),
                Some(
                    self.store
                        .snapshot_at_time(decode_read_time(read_time, now())?)
                        .map_err(snapshot_status)?,
                ),
            ),
        };
        let snapshot = if let Some(snapshot) = historical {
            snapshot
        } else if token.is_empty() {
            self.store.snapshot()
        } else {
            self.snapshot_for_transaction(&database, &token)?
        };
        let descending = parse_list_order(&request.order_by)?;
        let mut documents = snapshot
            .documents(&database)
            .into_iter()
            .filter(|(key, _)| {
                direct_child_matches(key.path(), parent.as_deref(), &request.collection_id)
            })
            .collect::<Vec<_>>();
        if descending {
            documents.reverse();
        }
        if !request.page_token.is_empty() {
            documents = documents
                .into_iter()
                .skip_while(|(key, _)| key.to_string() != request.page_token)
                .skip(1)
                .collect();
        }
        let page_size = normalize_page_size(request.page_size);
        let has_more = documents.len() > page_size;
        documents.truncate(page_size);
        let next_page_token = if has_more {
            documents
                .last()
                .map(|(key, _)| key.to_string())
                .unwrap_or_default()
        } else {
            String::new()
        };
        for (key, document) in &documents {
            self.record_read(&token, key, Some(document));
        }
        let documents = documents
            .into_iter()
            .map(|(key, document)| encode_document_masked(&key, &document, request.mask.as_ref()))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Response::new(ListDocumentsResponse {
            documents,
            next_page_token,
        }))
    }

    async fn update_document(
        &self,
        request: Request<UpdateDocumentRequest>,
    ) -> Result<Response<proto::Document>, Status> {
        let request = request.into_inner();
        let write = proto::Write {
            update_mask: request.update_mask,
            current_document: request.current_document,
            operation: Some(Operation::Update(
                request
                    .document
                    .ok_or_else(|| Status::invalid_argument("document is required"))?,
            )),
            ..proto::Write::default()
        };
        let decoded = decode_write(write)?;
        let key = decoded.key.clone();
        let _guard = self.write_lock();
        self.apply_writes(&[decoded])?;
        let snapshot = self.store.snapshot();
        let document = snapshot
            .get(&key)
            .ok_or_else(|| Status::internal("updated document disappeared"))?;
        Ok(Response::new(encode_document_masked(
            &key,
            &document,
            request.mask.as_ref(),
        )?))
    }

    async fn delete_document(
        &self,
        request: Request<DeleteDocumentRequest>,
    ) -> Result<Response<()>, Status> {
        let request = request.into_inner();
        let decoded = decode_write(proto::Write {
            current_document: request.current_document,
            operation: Some(Operation::Delete(request.name)),
            ..proto::Write::default()
        })?;
        let _guard = self.write_lock();
        self.apply_writes(&[decoded])?;
        Ok(Response::new(()))
    }

    type BatchGetDocumentsStream = ResponseStream<BatchGetDocumentsResponse>;

    async fn batch_get_documents(
        &self,
        request: Request<BatchGetDocumentsRequest>,
    ) -> Result<Response<Self::BatchGetDocumentsStream>, Status> {
        let request = request.into_inner();
        let database = decode_database_name(&request.database)?;
        let (token, new_transaction, historical) = match request.consistency_selector {
            None => (Vec::new(), false, None),
            Some(batch_get_documents_request::ConsistencySelector::Transaction(token)) => {
                (token, false, None)
            }
            Some(batch_get_documents_request::ConsistencySelector::NewTransaction(options)) => (
                self.begin_transaction_inner(database.clone(), Some(options))?,
                true,
                None,
            ),
            Some(batch_get_documents_request::ConsistencySelector::ReadTime(read_time)) => (
                Vec::new(),
                false,
                Some(
                    self.store
                        .snapshot_at_time(decode_read_time(read_time, now())?)
                        .map_err(snapshot_status)?,
                ),
            ),
        };
        let snapshot = if let Some(snapshot) = historical {
            snapshot
        } else if token.is_empty() {
            self.store.snapshot()
        } else {
            self.snapshot_for_transaction(&database, &token)?
        };
        let read_time = Some(encode_timestamp(now()));
        let mut seen = BTreeSet::new();
        let mut responses = Vec::new();
        for name in request.documents {
            if !seen.insert(name.clone()) {
                continue;
            }
            let key = decode_document_name(&name)?;
            if key.database() != &database {
                return Err(Status::invalid_argument(
                    "batch document belongs to a different database",
                ));
            }
            let document = snapshot.get(&key);
            self.record_read(&token, &key, document.as_deref());
            let result = if let Some(document) = document {
                batch_get_documents_response::Result::Found(encode_document_masked(
                    &key,
                    &document,
                    request.mask.as_ref(),
                )?)
            } else {
                batch_get_documents_response::Result::Missing(name)
            };
            responses.push(BatchGetDocumentsResponse {
                transaction: if new_transaction && responses.is_empty() {
                    token.clone()
                } else {
                    Vec::new()
                },
                read_time,
                result: Some(result),
            });
        }
        if new_transaction && responses.is_empty() {
            responses.push(BatchGetDocumentsResponse {
                transaction: token,
                read_time,
                result: None,
            });
        }
        Ok(Response::new(Box::pin(iter(responses.into_iter().map(Ok)))))
    }

    async fn begin_transaction(
        &self,
        request: Request<BeginTransactionRequest>,
    ) -> Result<Response<BeginTransactionResponse>, Status> {
        let request = request.into_inner();
        let database = decode_database_name(&request.database)?;
        let transaction = self.begin_transaction_inner(database, request.options)?;
        Ok(Response::new(BeginTransactionResponse { transaction }))
    }

    async fn commit(
        &self,
        request: Request<CommitRequest>,
    ) -> Result<Response<CommitResponse>, Status> {
        let request = request.into_inner();
        let database = decode_database_name(&request.database)?;
        let decoded = request
            .writes
            .into_iter()
            .map(decode_write)
            .collect::<Result<Vec<_>, _>>()?;
        if decoded
            .iter()
            .any(|write| write.key.database() != &database)
        {
            return Err(Status::invalid_argument(
                "commit write belongs to a different database",
            ));
        }

        let _guard = self.write_lock();
        if !request.transaction.is_empty() {
            let transaction = self
                .transaction_states()
                .remove(&request.transaction)
                .ok_or_else(|| Status::invalid_argument("unknown transaction"))?;
            if transaction.database != database {
                return Err(Status::invalid_argument(
                    "transaction belongs to a different database",
                ));
            }
            if transaction.read_only && !decoded.is_empty() {
                return Err(Status::failed_precondition(
                    "read-only transaction cannot contain writes",
                ));
            }
            let current = self.store.snapshot();
            for (key, expected) in transaction.reads {
                let actual = current.get(&key).map(|document| document.update_time());
                if actual != expected {
                    return Err(Status::aborted(format!(
                        "transaction document changed: {key}"
                    )));
                }
            }
        }
        Ok(Response::new(self.apply_writes(&decoded)?))
    }

    async fn rollback(&self, request: Request<RollbackRequest>) -> Result<Response<()>, Status> {
        let request = request.into_inner();
        let database = decode_database_name(&request.database)?;
        let transaction = self
            .transaction_states()
            .remove(&request.transaction)
            .ok_or_else(|| Status::invalid_argument("unknown transaction"))?;
        if transaction.database != database {
            return Err(Status::invalid_argument(
                "transaction belongs to a different database",
            ));
        }
        Ok(Response::new(()))
    }

    type RunQueryStream = ResponseStream<RunQueryResponse>;

    async fn run_query(
        &self,
        request: Request<RunQueryRequest>,
    ) -> Result<Response<Self::RunQueryStream>, Status> {
        let request = request.into_inner();
        if request.explain_options.is_some() {
            return Err(Status::unimplemented(
                "query explain metrics await a production fixture",
            ));
        }
        let (database, parent) = decode_parent(&request.parent)?;
        let Some(run_query_request::QueryType::StructuredQuery(structured)) = request.query_type
        else {
            return Err(Status::invalid_argument("structured query is required"));
        };
        let skipped_results = structured.offset;
        let query = decode_query(parent.as_deref(), structured)?;
        self.query_policy
            .validate(&query)
            .map_err(|error| index_status(&error))?;
        let (token, new_transaction, historical) = match request.consistency_selector {
            None => (Vec::new(), false, None),
            Some(run_query_request::ConsistencySelector::Transaction(token)) => {
                (token, false, None)
            }
            Some(run_query_request::ConsistencySelector::NewTransaction(options)) => (
                self.begin_transaction_inner(database.clone(), Some(options))?,
                true,
                None,
            ),
            Some(run_query_request::ConsistencySelector::ReadTime(read_time)) => (
                Vec::new(),
                false,
                Some(
                    self.store
                        .snapshot_at_time(decode_read_time(read_time, now())?)
                        .map_err(snapshot_status)?,
                ),
            ),
        };
        let snapshot = if let Some(snapshot) = historical {
            snapshot
        } else if token.is_empty() {
            self.store.snapshot()
        } else {
            self.snapshot_for_transaction(&database, &token)?
        };
        let documents = execute(&snapshot, &database, &query, self.query_policy.edition())
            .map_err(|error| query_status(&error))?;
        let read_time = Some(encode_timestamp(now()));
        let mut responses = Vec::with_capacity(documents.len() + usize::from(new_transaction));
        if new_transaction {
            responses.push(RunQueryResponse {
                transaction: token.clone(),
                ..RunQueryResponse::default()
            });
        }
        for (index, document) in documents.iter().enumerate() {
            self.record_read(&token, document.key(), Some(document.document().as_ref()));
            responses.push(RunQueryResponse {
                document: Some(encode_query_document(document)?),
                read_time,
                skipped_results: if index == 0 { skipped_results } else { 0 },
                ..RunQueryResponse::default()
            });
        }
        if documents.is_empty() {
            responses.push(RunQueryResponse {
                read_time,
                ..RunQueryResponse::default()
            });
        }
        Ok(Response::new(Box::pin(iter(responses.into_iter().map(Ok)))))
    }

    type ExecutePipelineStream = ResponseStream<ExecutePipelineResponse>;

    async fn execute_pipeline(
        &self,
        _request: Request<ExecutePipelineRequest>,
    ) -> Result<Response<Self::ExecutePipelineStream>, Status> {
        Err(Status::unimplemented(
            "ExecutePipeline requires production fixtures",
        ))
    }

    type RunAggregationQueryStream = ResponseStream<RunAggregationQueryResponse>;

    async fn run_aggregation_query(
        &self,
        request: Request<RunAggregationQueryRequest>,
    ) -> Result<Response<Self::RunAggregationQueryStream>, Status> {
        let request = request.into_inner();
        if request.explain_options.is_some() {
            return Err(Status::unimplemented(
                "aggregation explain metrics await a production fixture",
            ));
        }
        let (database, parent) = decode_parent(&request.parent)?;
        let Some(run_aggregation_query_request::QueryType::StructuredAggregationQuery(
            aggregation_query,
        )) = request.query_type
        else {
            return Err(Status::invalid_argument(
                "structured aggregation query is required",
            ));
        };
        let (structured, aggregation) = decode_aggregation(aggregation_query)?;
        let query = decode_query(parent.as_deref(), structured)?;
        self.query_policy
            .validate(&query)
            .map_err(|error| index_status(&error))?;
        let (token, new_transaction, historical) = match request.consistency_selector {
            None => (Vec::new(), false, None),
            Some(run_aggregation_query_request::ConsistencySelector::Transaction(token)) => {
                (token, false, None)
            }
            Some(run_aggregation_query_request::ConsistencySelector::NewTransaction(options)) => (
                self.begin_transaction_inner(database.clone(), Some(options))?,
                true,
                None,
            ),
            Some(run_aggregation_query_request::ConsistencySelector::ReadTime(read_time)) => (
                Vec::new(),
                false,
                Some(
                    self.store
                        .snapshot_at_time(decode_read_time(read_time, now())?)
                        .map_err(snapshot_status)?,
                ),
            ),
        };
        let snapshot = if let Some(snapshot) = historical {
            snapshot
        } else if token.is_empty() {
            self.store.snapshot()
        } else {
            self.snapshot_for_transaction(&database, &token)?
        };
        let documents = execute(&snapshot, &database, &query, self.query_policy.edition())
            .map_err(|error| query_status(&error))?;
        for document in &documents {
            self.record_read(&token, document.key(), Some(document.document().as_ref()));
        }
        let mut fields = aggregate(&documents, &aggregation.operations);
        for (alias, bound) in aggregation.count_bounds {
            if let Some(Value::Integer(count)) = fields.get_mut(&alias) {
                let bound = i64::try_from(bound).unwrap_or(i64::MAX);
                *count = (*count).min(bound);
            }
        }
        let result = proto::AggregationResult {
            aggregate_fields: encode_fields(&fields)?,
        };
        let mut responses = Vec::with_capacity(1 + usize::from(new_transaction));
        if new_transaction {
            responses.push(RunAggregationQueryResponse {
                transaction: token,
                ..RunAggregationQueryResponse::default()
            });
        }
        responses.push(RunAggregationQueryResponse {
            result: Some(result),
            read_time: Some(encode_timestamp(now())),
            ..RunAggregationQueryResponse::default()
        });
        Ok(Response::new(Box::pin(iter(responses.into_iter().map(Ok)))))
    }

    async fn partition_query(
        &self,
        request: Request<PartitionQueryRequest>,
    ) -> Result<Response<PartitionQueryResponse>, Status> {
        let request = request.into_inner();
        let snapshot = match request.consistency_selector {
            None => self.store.snapshot(),
            Some(partition_query_request::ConsistencySelector::ReadTime(read_time)) => self
                .store
                .snapshot_at_time(decode_read_time(read_time, now())?)
                .map_err(snapshot_status)?,
        };
        let (database, parent) = decode_parent(&request.parent)?;
        if parent.is_some() {
            return Err(Status::invalid_argument(
                "PartitionQuery parent must be the database document root",
            ));
        }
        let Some(partition_query_request::QueryType::StructuredQuery(structured)) =
            request.query_type
        else {
            return Err(Status::invalid_argument("structured query is required"));
        };
        let query = decode_query(None, structured)?;
        self.query_policy
            .validate(&query)
            .map_err(|error| index_status(&error))?;
        let maximum = usize::try_from(request.partition_count)
            .map_err(|_| Status::invalid_argument("partition_count must be positive"))?;
        let mut partitions = partition(
            &snapshot,
            &database,
            &query,
            self.query_policy.edition(),
            maximum,
        )
        .map_err(|error| query_status(&error))?;
        let offset = if request.page_token.is_empty() {
            0
        } else {
            request
                .page_token
                .parse::<usize>()
                .map_err(|_| Status::invalid_argument("invalid partition page token"))?
        };
        if offset > partitions.len() {
            return Err(Status::invalid_argument("invalid partition page token"));
        }
        partitions.drain(..offset);
        let page_size = normalize_page_size(request.page_size);
        let has_more = partitions.len() > page_size;
        partitions.truncate(page_size);
        let returned = partitions.len();
        let partitions = partitions
            .into_iter()
            .map(|partition| {
                Ok(proto::Cursor {
                    values: partition
                        .values
                        .iter()
                        .map(encode_value)
                        .collect::<Result<Vec<_>, _>>()?,
                    before: partition.before,
                })
            })
            .collect::<Result<Vec<_>, Status>>()?;
        Ok(Response::new(PartitionQueryResponse {
            partitions,
            next_page_token: if has_more {
                (offset + returned).to_string()
            } else {
                String::new()
            },
        }))
    }

    type WriteStream = ResponseStream<WriteResponse>;

    async fn write(
        &self,
        request: Request<tonic::Streaming<WriteRequest>>,
    ) -> Result<Response<Self::WriteStream>, Status> {
        Ok(Response::new(crate::write_stream::stream(
            self.clone(),
            request.into_inner(),
        )))
    }

    type ListenStream = ResponseStream<ListenResponse>;

    async fn listen(
        &self,
        request: Request<tonic::Streaming<ListenRequest>>,
    ) -> Result<Response<Self::ListenStream>, Status> {
        Ok(Response::new(crate::listen::stream(
            self.store.clone(),
            self.query_policy.clone(),
            request.into_inner(),
        )))
    }

    async fn list_collection_ids(
        &self,
        request: Request<ListCollectionIdsRequest>,
    ) -> Result<Response<ListCollectionIdsResponse>, Status> {
        let request = request.into_inner();
        let snapshot = match request.consistency_selector {
            None => self.store.snapshot(),
            Some(list_collection_ids_request::ConsistencySelector::ReadTime(read_time)) => self
                .store
                .snapshot_at_time(decode_read_time(read_time, now())?)
                .map_err(snapshot_status)?,
        };
        let (database, parent) = decode_parent(&request.parent)?;
        let parent_segments = parent
            .as_deref()
            .map_or_else(Vec::new, |path| path.split('/').collect::<Vec<_>>());
        let mut collection_ids = snapshot
            .documents(&database)
            .into_iter()
            .filter_map(|(key, _)| {
                let segments = key.path().split('/').collect::<Vec<_>>();
                (segments.len() >= parent_segments.len() + 2
                    && segments[..parent_segments.len()] == parent_segments)
                    .then(|| segments[parent_segments.len()].to_owned())
            })
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        if !request.page_token.is_empty() {
            collection_ids.retain(|id| id > &request.page_token);
        }
        let page_size = normalize_page_size(request.page_size);
        let has_more = collection_ids.len() > page_size;
        collection_ids.truncate(page_size);
        let next_page_token = if has_more {
            collection_ids.last().cloned().unwrap_or_default()
        } else {
            String::new()
        };
        Ok(Response::new(ListCollectionIdsResponse {
            collection_ids,
            next_page_token,
        }))
    }

    async fn batch_write(
        &self,
        request: Request<BatchWriteRequest>,
    ) -> Result<Response<BatchWriteResponse>, Status> {
        let request = request.into_inner();
        let database = decode_database_name(&request.database)?;
        let decoded = request
            .writes
            .into_iter()
            .map(decode_write)
            .collect::<Result<Vec<_>, _>>()?;
        let mut keys = BTreeSet::new();
        if decoded
            .iter()
            .any(|write| write.key.database() != &database || !keys.insert(write.key.clone()))
        {
            return Err(Status::invalid_argument(
                "batch writes must target distinct documents in one database",
            ));
        }

        let _guard = self.write_lock();
        let mut write_results = Vec::with_capacity(decoded.len());
        let mut statuses = Vec::with_capacity(decoded.len());
        for write in decoded {
            match self.apply_writes(&[write]) {
                Ok(response) => {
                    write_results.extend(response.write_results);
                    statuses.push(rpc::Status::default());
                }
                Err(status) => {
                    write_results.push(WriteResult::default());
                    statuses.push(rpc_status(&status));
                }
            }
        }
        Ok(Response::new(BatchWriteResponse {
            write_results,
            status: statuses,
        }))
    }

    async fn create_document(
        &self,
        request: Request<CreateDocumentRequest>,
    ) -> Result<Response<proto::Document>, Status> {
        let request = request.into_inner();
        let (database, parent) = decode_parent(&request.parent)?;
        if request.collection_id.is_empty() || request.collection_id.contains('/') {
            return Err(Status::invalid_argument("invalid collection_id"));
        }
        let document_id = if request.document_id.is_empty() {
            format!(
                "fireside-{:016x}",
                self.next_id.fetch_add(1, Ordering::Relaxed)
            )
        } else {
            request.document_id
        };
        if document_id.contains('/') {
            return Err(Status::invalid_argument("invalid document_id"));
        }
        let document = request
            .document
            .ok_or_else(|| Status::invalid_argument("document is required"))?;
        if !document.name.is_empty() {
            return Err(Status::invalid_argument(
                "document name must be empty for CreateDocument",
            ));
        }
        let path = [parent, Some(request.collection_id), Some(document_id)]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join("/");
        let key = DocumentKey::new(database, path)
            .map_err(|error| Status::invalid_argument(error.to_string()))?;
        let fields = decode_fields(document.fields)?;
        let _guard = self.write_lock();
        self.store
            .commit(&[Write::Create {
                key: key.clone(),
                fields,
            }])
            .map_err(commit_status)?;
        let snapshot = self.store.snapshot();
        let document = snapshot
            .get(&key)
            .ok_or_else(|| Status::internal("created document disappeared"))?;
        Ok(Response::new(encode_document_masked(
            &key,
            &document,
            request.mask.as_ref(),
        )?))
    }
}

fn write_result(
    decoded: &DecodedWrite,
    snapshot: &Snapshot,
    commit: CommitResult,
) -> Result<WriteResult, Status> {
    let document = snapshot.get(&decoded.key);
    let update_time = document
        .as_deref()
        .map(Document::update_time)
        .map(encode_timestamp);
    let transform_results = decoded
        .transforms
        .iter()
        .map(|transform| transform_result(transform, document.as_deref(), commit.commit_time))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(WriteResult {
        update_time,
        transform_results,
    })
}

fn encode_query_document(document: &QueryDocument) -> Result<proto::Document, Status> {
    Ok(proto::Document {
        name: document.key().to_string(),
        fields: encode_fields(document.fields())?,
        create_time: Some(encode_timestamp(document.document().create_time())),
        update_time: Some(encode_timestamp(document.document().update_time())),
    })
}

fn transform_result(
    transform: &FieldTransform,
    document: Option<&Document>,
    commit_time: Timestamp,
) -> Result<proto::Value, Status> {
    match &transform.operation {
        TransformOperation::ArrayUnion(_) | TransformOperation::ArrayRemove(_) => {
            encode_value(&Value::Null)
        }
        TransformOperation::ServerTimestamp => encode_value(&Value::Timestamp(commit_time)),
        TransformOperation::Increment(_) => document
            .and_then(|document| nested_value(document.fields(), transform.path.segments()))
            .map_or_else(
                || Err(Status::internal("transform result field is missing")),
                encode_value,
            ),
    }
}

fn index_status(error: &IndexConfigError) -> Status {
    Status::failed_precondition(error.to_string())
}

fn commit_status(error: CommitError) -> Status {
    match error {
        CommitError::AlreadyExists(key) => {
            Status::already_exists(format!("document already exists: {key}"))
        }
        CommitError::ExistencePrecondition {
            key,
            expected: true,
        } => Status::not_found(format!("document not found: {key}")),
        CommitError::ExistencePrecondition {
            key,
            expected: false,
        } => Status::already_exists(format!("document already exists: {key}")),
        CommitError::UpdateTimePrecondition { key, .. } => {
            Status::failed_precondition(format!("update time precondition failed: {key}"))
        }
        CommitError::InvalidIncrementOperand { .. } => Status::invalid_argument(error.to_string()),
        CommitError::RevisionExhausted => Status::resource_exhausted(error.to_string()),
        CommitError::PersistenceUnavailable(_) => Status::unavailable(error.to_string()),
    }
}

fn snapshot_status(error: SnapshotError) -> Status {
    match error {
        SnapshotError::ResetRequired(_) | SnapshotError::ReadTimeExpired { .. } => {
            Status::failed_precondition(error.to_string())
        }
        SnapshotError::FutureRevision { .. } => Status::invalid_argument(error.to_string()),
    }
}

fn rpc_status(status: &Status) -> rpc::Status {
    rpc::Status {
        code: status.code() as i32,
        message: status.message().to_owned(),
        details: Vec::new(),
    }
}

fn parse_list_order(order: &str) -> Result<bool, Status> {
    match order.trim().to_ascii_lowercase().as_str() {
        "" | "__name__" | "__name__ asc" => Ok(false),
        "__name__ desc" => Ok(true),
        _ => Err(Status::unimplemented(
            "ListDocuments currently supports only __name__ ordering",
        )),
    }
}

fn direct_child_matches(path: &str, parent: Option<&str>, collection_id: &str) -> bool {
    let segments = path.split('/').collect::<Vec<_>>();
    let parent_segments = parent.map_or_else(Vec::new, |path| path.split('/').collect());
    if segments.len() < parent_segments.len() + 2
        || segments[..parent_segments.len()] != parent_segments
    {
        return false;
    }
    if collection_id.is_empty() {
        segments.len() == parent_segments.len() + 2
    } else {
        segments.len() == parent_segments.len() + 2
            && segments[parent_segments.len()] == collection_id
    }
}

fn normalize_page_size(page_size: i32) -> usize {
    if page_size <= 0 {
        100
    } else {
        usize::try_from(page_size).unwrap_or(1_000).min(1_000)
    }
}

fn now() -> Timestamp {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    Timestamp::new(
        i64::try_from(elapsed.as_secs()).unwrap_or(i64::MAX),
        elapsed.subsec_nanos(),
    )
    .expect("system subsecond nanoseconds are valid")
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::google::firestore::v1::run_aggregation_query_request;
    use crate::google::firestore::v1::run_query_request;
    use crate::google::firestore::v1::structured_aggregation_query;
    use crate::google::firestore::v1::structured_aggregation_query::QueryType as AggregationQueryType;
    use crate::google::firestore::v1::structured_aggregation_query::aggregation;
    use crate::google::firestore::v1::structured_aggregation_query::aggregation::Operator as AggregationOperator;
    use crate::google::firestore::v1::structured_query::{
        CollectionSelector, Direction, FieldReference, Order,
    };
    use crate::google::firestore::v1::{
        DocumentMask, StructuredAggregationQuery, StructuredQuery, precondition,
    };

    const DATABASE: &str = "projects/demo/databases/tenant-a";
    const DOCUMENT: &str = "projects/demo/databases/tenant-a/documents/cities/kl";

    fn integer_document(name: &str, value: i64) -> proto::Document {
        proto::Document {
            name: name.to_owned(),
            fields: HashMap::from([(
                "value".to_owned(),
                proto::Value {
                    value_type: Some(proto::value::ValueType::IntegerValue(value)),
                },
            )]),
            ..proto::Document::default()
        }
    }

    #[tokio::test]
    async fn crud_preserves_named_database_and_error_codes() {
        let service = FirestoreService::default();
        let created = service
            .create_document(Request::new(CreateDocumentRequest {
                parent: format!("{DATABASE}/documents"),
                collection_id: "cities".to_owned(),
                document_id: "kl".to_owned(),
                document: Some(integer_document("", 1)),
                ..CreateDocumentRequest::default()
            }))
            .await
            .expect("create should succeed")
            .into_inner();
        assert_eq!(created.name, DOCUMENT);

        let duplicate = service
            .create_document(Request::new(CreateDocumentRequest {
                parent: format!("{DATABASE}/documents"),
                collection_id: "cities".to_owned(),
                document_id: "kl".to_owned(),
                document: Some(integer_document("", 2)),
                ..CreateDocumentRequest::default()
            }))
            .await
            .expect_err("duplicate create should fail");
        assert_eq!(duplicate.code(), tonic::Code::AlreadyExists);

        let stale_time = created
            .update_time
            .expect("created document should have an update time");
        service
            .update_document(Request::new(UpdateDocumentRequest {
                document: Some(integer_document(DOCUMENT, 2)),
                update_mask: Some(DocumentMask {
                    field_paths: vec!["value".to_owned()],
                }),
                ..UpdateDocumentRequest::default()
            }))
            .await
            .expect("unconditional update should succeed");
        let stale = service
            .update_document(Request::new(UpdateDocumentRequest {
                document: Some(integer_document(DOCUMENT, 3)),
                update_mask: Some(DocumentMask {
                    field_paths: vec!["value".to_owned()],
                }),
                current_document: Some(proto::Precondition {
                    condition_type: Some(precondition::ConditionType::UpdateTime(stale_time)),
                }),
                ..UpdateDocumentRequest::default()
            }))
            .await
            .expect_err("stale compare-and-set should fail");
        assert_eq!(stale.code(), tonic::Code::FailedPrecondition);

        let missing = service
            .update_document(Request::new(UpdateDocumentRequest {
                document: Some(integer_document(
                    "projects/demo/databases/tenant-a/documents/cities/missing",
                    1,
                )),
                update_mask: Some(DocumentMask {
                    field_paths: vec!["value".to_owned()],
                }),
                current_document: Some(proto::Precondition {
                    condition_type: Some(precondition::ConditionType::Exists(true)),
                }),
                ..UpdateDocumentRequest::default()
            }))
            .await
            .expect_err("missing update should fail");
        assert_eq!(missing.code(), tonic::Code::NotFound);
    }

    #[tokio::test]
    async fn concurrent_transactions_abort_one_writer() {
        let service = FirestoreService::default();
        service
            .create_document(Request::new(CreateDocumentRequest {
                parent: format!("{DATABASE}/documents"),
                collection_id: "cities".to_owned(),
                document_id: "kl".to_owned(),
                document: Some(integer_document("", 1)),
                ..CreateDocumentRequest::default()
            }))
            .await
            .expect("create should succeed");

        let first = service
            .begin_transaction(Request::new(BeginTransactionRequest {
                database: DATABASE.to_owned(),
                ..BeginTransactionRequest::default()
            }))
            .await
            .expect("first transaction should begin")
            .into_inner()
            .transaction;
        let second = service
            .begin_transaction(Request::new(BeginTransactionRequest {
                database: DATABASE.to_owned(),
                ..BeginTransactionRequest::default()
            }))
            .await
            .expect("second transaction should begin")
            .into_inner()
            .transaction;
        for token in [&first, &second] {
            service
                .get_document(Request::new(GetDocumentRequest {
                    name: DOCUMENT.to_owned(),
                    consistency_selector: Some(
                        get_document_request::ConsistencySelector::Transaction(token.clone()),
                    ),
                    ..GetDocumentRequest::default()
                }))
                .await
                .expect("transaction read should succeed");
        }

        service
            .commit(Request::new(CommitRequest {
                database: DATABASE.to_owned(),
                transaction: first,
                writes: vec![proto::Write {
                    operation: Some(Operation::Update(integer_document(DOCUMENT, 2))),
                    update_mask: Some(DocumentMask {
                        field_paths: vec!["value".to_owned()],
                    }),
                    ..proto::Write::default()
                }],
                ..CommitRequest::default()
            }))
            .await
            .expect("first transaction should commit");
        let conflict = service
            .commit(Request::new(CommitRequest {
                database: DATABASE.to_owned(),
                transaction: second,
                writes: vec![proto::Write {
                    operation: Some(Operation::Update(integer_document(DOCUMENT, 3))),
                    update_mask: Some(DocumentMask {
                        field_paths: vec!["value".to_owned()],
                    }),
                    ..proto::Write::default()
                }],
                ..CommitRequest::default()
            }))
            .await
            .expect_err("second transaction should abort");
        assert_eq!(conflict.code(), tonic::Code::Aborted);
    }

    async fn seeded_query_service() -> FirestoreService {
        let service = FirestoreService::default();
        for (id, value) in [("kl", 2), ("penang", 1)] {
            service
                .create_document(Request::new(CreateDocumentRequest {
                    parent: format!("{DATABASE}/documents"),
                    collection_id: "cities".to_owned(),
                    document_id: id.to_owned(),
                    document: Some(integer_document("", value)),
                    ..CreateDocumentRequest::default()
                }))
                .await
                .expect("seed create should succeed");
        }
        service
    }

    fn base_query() -> StructuredQuery {
        StructuredQuery {
            from: vec![CollectionSelector {
                collection_id: "cities".to_owned(),
                all_descendants: false,
            }],
            order_by: vec![Order {
                field: Some(FieldReference {
                    field_path: "value".to_owned(),
                }),
                direction: Direction::Ascending as i32,
            }],
            ..StructuredQuery::default()
        }
    }

    #[tokio::test]
    async fn run_query_executes_the_query_engine() {
        use tokio_stream::StreamExt as _;

        let service = seeded_query_service().await;
        let mut query_stream = service
            .run_query(Request::new(RunQueryRequest {
                parent: format!("{DATABASE}/documents"),
                query_type: Some(run_query_request::QueryType::StructuredQuery(base_query())),
                ..RunQueryRequest::default()
            }))
            .await
            .expect("query should start")
            .into_inner();
        let first = query_stream
            .next()
            .await
            .expect("first result should exist")
            .expect("first result should succeed")
            .document
            .expect("first response should contain a document");
        assert!(first.name.ends_with("/cities/penang"));
        assert!(query_stream.next().await.is_some());
        assert!(query_stream.next().await.is_none());
    }

    #[tokio::test]
    async fn aggregation_rpc_executes_the_query_engine() {
        use tokio_stream::StreamExt as _;

        let service = seeded_query_service().await;
        let mut aggregation_stream = service
            .run_aggregation_query(Request::new(RunAggregationQueryRequest {
                parent: format!("{DATABASE}/documents"),
                query_type: Some(
                    run_aggregation_query_request::QueryType::StructuredAggregationQuery(
                        StructuredAggregationQuery {
                            aggregations: vec![structured_aggregation_query::Aggregation {
                                alias: "total".to_owned(),
                                operator: Some(AggregationOperator::Count(aggregation::Count {
                                    up_to: None,
                                })),
                            }],
                            query_type: Some(AggregationQueryType::StructuredQuery(base_query())),
                        },
                    ),
                ),
                ..RunAggregationQueryRequest::default()
            }))
            .await
            .expect("aggregation should start")
            .into_inner();
        let aggregate = aggregation_stream
            .next()
            .await
            .expect("aggregate result should exist")
            .expect("aggregate result should succeed")
            .result
            .expect("response should contain an aggregate");
        assert!(matches!(
            aggregate
                .aggregate_fields
                .get("total")
                .and_then(|value| value.value_type.as_ref()),
            Some(proto::value::ValueType::IntegerValue(2))
        ));
    }

    #[tokio::test]
    async fn partition_rpc_executes_the_query_engine() {
        let service = seeded_query_service().await;

        let partition = service
            .partition_query(Request::new(PartitionQueryRequest {
                parent: format!("{DATABASE}/documents"),
                partition_count: 1,
                query_type: Some(partition_query_request::QueryType::StructuredQuery(
                    StructuredQuery {
                        from: vec![CollectionSelector {
                            collection_id: "cities".to_owned(),
                            all_descendants: true,
                        }],
                        order_by: vec![Order {
                            field: Some(FieldReference {
                                field_path: "__name__".to_owned(),
                            }),
                            direction: Direction::Ascending as i32,
                        }],
                        ..StructuredQuery::default()
                    },
                )),
                ..PartitionQueryRequest::default()
            }))
            .await
            .expect("partition query should succeed")
            .into_inner();
        assert_eq!(partition.partitions.len(), 1);
        assert!(!partition.partitions[0].before);
    }
}
