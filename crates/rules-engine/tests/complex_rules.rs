use std::collections::BTreeMap;

use fireside_rules_engine::{
    Auth, DocumentAccess, DocumentAccessError, EvaluationRequest, Query, RequestOperation,
    Resource, Ruleset, Timestamp, Value, compile,
};

const COMPLEX_RULES: &str =
    include_str!("../../../conformance/fixtures/rules-v2/complex-firestore.rules");
const ROOT: &str = "/databases/(default)/documents";

#[test]
#[allow(clippy::too_many_lines)]
fn replays_all_45_frozen_complex_rules_cases() {
    let rules = compile(COMPLEX_RULES).expect("frozen complex rules should compile");
    let access = FixtureAccess::seeded();
    let alice = auth("alice", "editor", "tenant-a");
    let bob = auth("bob", "reader", "tenant-b");
    let admin = auth("admin", "admin", "tenant-a");

    assert_case(
        &rules,
        &access,
        Case::get("public-get", "public/news"),
        true,
    );
    assert_case(
        &rules,
        &access,
        Case::list("public-list-bounded", "public/query", 10),
        true,
    );
    assert_case(
        &rules,
        &access,
        Case::list("public-list-oversized", "public/query", 51),
        false,
    );
    assert_case(
        &rules,
        &access,
        Case::get("tenant-claim-read", "tenants/tenant-a").auth(alice.clone()),
        true,
    );
    assert_case(
        &rules,
        &access,
        Case::get("tenant-wrong-claim", "tenants/tenant-a").auth(bob.clone()),
        false,
    );
    assert_case(
        &rules,
        &access,
        Case::update(
            "tenant-admin-update",
            "tenants/tenant-a",
            map(&[("name", "Tenant A2".into()), ("status", "active".into())]),
        )
        .auth(admin.clone()),
        true,
    );
    assert_case(
        &rules,
        &access,
        Case::update(
            "tenant-editor-update",
            "tenants/tenant-a",
            map(&[("name", "Nope".into()), ("status", "active".into())]),
        )
        .auth(alice.clone()),
        false,
    );
    assert_case(
        &rules,
        &access,
        Case::get("member-self-read", "tenants/tenant-a/members/alice").auth(alice.clone()),
        true,
    );
    assert_case(
        &rules,
        &access,
        Case::get("member-other-read", "tenants/tenant-a/members/alice").auth(bob.clone()),
        false,
    );
    assert_case(
        &rules,
        &access,
        Case::get("project-member-read", "tenants/tenant-a/projects/project-1").auth(alice.clone()),
        true,
    );
    assert_case(
        &rules,
        &access,
        Case::get(
            "project-nonmember-read",
            "tenants/tenant-a/projects/project-1",
        )
        .auth(bob.clone()),
        false,
    );
    assert_case(
        &rules,
        &access,
        Case::update(
            "project-owner-update",
            "tenants/tenant-a/projects/project-1",
            project("alice", "Renamed", 2),
        )
        .auth(alice.clone()),
        true,
    );
    assert_case(
        &rules,
        &access,
        Case::update(
            "project-owner-forbidden-change",
            "tenants/tenant-a/projects/project-1",
            project("bob", "Hijack", 3),
        )
        .auth(alice.clone()),
        false,
    );
    assert_case(
        &rules,
        &access,
        Case::delete(
            "project-admin-delete",
            "tenants/tenant-a/projects/delete-admin",
        )
        .auth(admin.clone()),
        true,
    );
    assert_case(
        &rules,
        &access,
        Case::delete(
            "project-member-delete",
            "tenants/tenant-a/projects/delete-member",
        )
        .auth(alice.clone()),
        false,
    );
    assert_case(
        &rules,
        &access,
        Case::get(
            "task-member-read",
            "tenants/tenant-a/projects/project-1/tasks/task-1",
        )
        .auth(alice.clone()),
        true,
    );
    assert_case(
        &rules,
        &access,
        Case::get(
            "task-nonmember-read",
            "tenants/tenant-a/projects/project-1/tasks/task-1",
        )
        .auth(bob.clone()),
        false,
    );
    assert_case(
        &rules,
        &access,
        Case::create(
            "task-self-create",
            "tenants/tenant-a/projects/project-1/tasks/task-create-alice",
            task("alice", "Mine", "open", 1),
        )
        .auth(alice.clone()),
        true,
    );
    assert_case(
        &rules,
        &access,
        Case::create(
            "task-other-create",
            "tenants/tenant-a/projects/project-1/tasks/task-create-bob",
            task("bob", "Other", "open", 1),
        )
        .auth(alice.clone()),
        false,
    );
    assert_case(
        &rules,
        &access,
        Case::update(
            "task-assignee-update",
            "tenants/tenant-a/projects/project-1/tasks/task-update-allow",
            task("alice", "Task", "done", 1),
        )
        .auth(alice.clone()),
        true,
    );
    assert_case(
        &rules,
        &access,
        Case::update(
            "task-forbidden-update",
            "tenants/tenant-a/projects/project-1/tasks/task-update-deny",
            task("alice", "Task", "open", 99),
        )
        .auth(alice.clone()),
        false,
    );
    assert_case(
        &rules,
        &access,
        Case::get(
            "comment-member-read",
            "tenants/tenant-a/projects/project-1/tasks/task-1/comments/comment-1",
        )
        .auth(alice.clone()),
        true,
    );
    assert_case(
        &rules,
        &access,
        Case::create(
            "comment-author-create",
            "tenants/tenant-a/projects/project-1/tasks/task-1/comments/comment-new",
            map(&[("authorId", "alice".into()), ("body", "hello".into())]),
        )
        .auth(alice.clone()),
        true,
    );
    assert_case(
        &rules,
        &access,
        Case::create(
            "comment-impersonation",
            "tenants/tenant-a/projects/project-1/tasks/task-1/comments/comment-bad",
            map(&[("authorId", "bob".into()), ("body", "hello".into())]),
        )
        .auth(alice.clone()),
        false,
    );
    assert_case(
        &rules,
        &access,
        Case::get("profile-self-read", "profiles/alice").auth(alice.clone()),
        true,
    );
    assert_case(
        &rules,
        &access,
        Case::get("profile-other-read", "profiles/alice").auth(bob.clone()),
        false,
    );
    assert_case(
        &rules,
        &access,
        Case::update(
            "profile-self-update",
            "profiles/alice",
            map(&[
                ("displayName", "Alice 2".into()),
                ("timezone", "UTC".into()),
            ]),
        )
        .auth(alice.clone()),
        true,
    );
    assert_case(
        &rules,
        &access,
        Case::update(
            "profile-role-injection",
            "profiles/alice",
            map(&[
                ("displayName", "Alice 3".into()),
                ("timezone", "UTC".into()),
                ("role", "admin".into()),
            ]),
        )
        .auth(alice.clone()),
        false,
    );
    let audit = map(&[
        ("actorId", "admin".into()),
        ("action", "update".into()),
        (
            "at",
            Value::Timestamp(Timestamp::parse_rfc3339("2026-09-01T08:00:00Z").expect("timestamp")),
        ),
    ]);
    assert_case(
        &rules,
        &access,
        Case::create("audit-admin-create", "audits/admin-event", audit.clone()).auth(admin.clone()),
        true,
    );
    assert_case(
        &rules,
        &access,
        Case::create(
            "audit-editor-create",
            "audits/editor-event",
            map(&[
                ("actorId", "alice".into()),
                ("action", "update".into()),
                (
                    "at",
                    Value::Timestamp(
                        Timestamp::parse_rfc3339("2026-09-01T08:00:00Z").expect("timestamp"),
                    ),
                ),
            ]),
        )
        .auth(alice.clone()),
        false,
    );
    assert_case(
        &rules,
        &access,
        Case::get(
            "recursive-asset-member",
            "tenants/tenant-a/assets/folder/deep/file",
        )
        .auth(alice.clone()),
        true,
    );
    assert_case(
        &rules,
        &access,
        Case::get(
            "recursive-asset-nonmember",
            "tenants/tenant-a/assets/folder/deep/file",
        )
        .auth(bob.clone()),
        false,
    );
    assert_case(
        &rules,
        &access,
        Case::get("stats-admin-read", "stats/overview").auth(admin.clone()),
        true,
    );
    assert_case(
        &rules,
        &access,
        Case::get("stats-editor-read", "stats/overview").auth(alice.clone()),
        false,
    );
    for index in 0..8 {
        let id = format!("{index:02}");
        assert_case(
            &rules,
            &access,
            Case::get(
                format!("generated-entity-{id}"),
                format!("tenants/tenant-a/entity-{id}/document-{id}"),
            )
            .auth(alice.clone()),
            true,
        );
    }
    assert_case(
        &rules,
        &access,
        Case::get(
            "generated-entity-wrong-tenant",
            "tenants/tenant-a/entity-00/document-00",
        )
        .auth(bob),
        false,
    );

    assert_atomic_case(&rules, &access, alice, 1, 2, 2, true);
    assert_atomic_case(&rules, &access, admin, 2, 3, 2, false);
}

fn assert_case(rules: &Ruleset, access: &FixtureAccess, case: Case, expected: bool) {
    let path = canonical(&case.path);
    let mut request = EvaluationRequest::new(case.operation, &path, request_time());
    request.auth = case.auth;
    request.resource = access.current.get(&path).cloned();
    request.request_resource = case.proposed.map(|data| Resource::new(&path, data));
    request.query = case.query;
    let result = rules.evaluate(&request, access);
    assert_eq!(result.allowed, expected, "{}: {result:?}", case.id);
}

fn assert_atomic_case(
    rules: &Ruleset,
    seeded_access: &FixtureAccess,
    auth: Auth,
    old_version: i64,
    new_version: i64,
    expected_version: i64,
    expected: bool,
) {
    let invariant_path = canonical("invariants/global");
    let new_invariant = Resource::new(
        &invariant_path,
        map(&[("version", Value::Integer(new_version))]),
    );
    let access = FixtureAccess {
        current: seeded_access
            .current
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .chain([(
                invariant_path.clone(),
                Resource::new(
                    &invariant_path,
                    map(&[("version", Value::Integer(old_version))]),
                ),
            )])
            .collect(),
        after: BTreeMap::from([(invariant_path.clone(), new_invariant.clone())]),
    };
    let mut invariant =
        EvaluationRequest::new(RequestOperation::Update, &invariant_path, request_time());
    invariant.auth = Some(auth.clone());
    invariant.resource = access.current.get(&invariant_path).cloned();
    invariant.request_resource = Some(new_invariant);
    let atomic_path = canonical(if expected {
        "atomic/allow"
    } else {
        "atomic/deny"
    });
    let mut atomic = EvaluationRequest::new(RequestOperation::Create, &atomic_path, request_time());
    atomic.auth = Some(auth);
    atomic.request_resource = Some(Resource::new(
        &atomic_path,
        map(&[("expectedVersion", Value::Integer(expected_version))]),
    ));
    let result = rules.evaluate_atomic(&[invariant, atomic], &access);
    assert_eq!(result.allowed, expected, "atomic: {result:?}");
}

#[derive(Clone)]
struct Case {
    id: String,
    operation: RequestOperation,
    path: String,
    auth: Option<Auth>,
    proposed: Option<BTreeMap<String, Value>>,
    query: Query,
}

impl Case {
    fn get(id: impl Into<String>, path: impl Into<String>) -> Self {
        Self::new(id, RequestOperation::Get, path, None)
    }

    fn list(id: impl Into<String>, path: impl Into<String>, limit: i64) -> Self {
        let mut value = Self::new(id, RequestOperation::List, path, None);
        value.query.limit = Some(limit);
        value
    }

    fn create(
        id: impl Into<String>,
        path: impl Into<String>,
        proposed: BTreeMap<String, Value>,
    ) -> Self {
        Self::new(id, RequestOperation::Create, path, Some(proposed))
    }

    fn update(
        id: impl Into<String>,
        path: impl Into<String>,
        proposed: BTreeMap<String, Value>,
    ) -> Self {
        Self::new(id, RequestOperation::Update, path, Some(proposed))
    }

    fn delete(id: impl Into<String>, path: impl Into<String>) -> Self {
        Self::new(id, RequestOperation::Delete, path, None)
    }

    fn new(
        id: impl Into<String>,
        operation: RequestOperation,
        path: impl Into<String>,
        proposed: Option<BTreeMap<String, Value>>,
    ) -> Self {
        Self {
            id: id.into(),
            operation,
            path: path.into(),
            auth: None,
            proposed,
            query: Query::default(),
        }
    }

    fn auth(mut self, auth: Auth) -> Self {
        self.auth = Some(auth);
        self
    }
}

struct FixtureAccess {
    current: BTreeMap<String, Resource>,
    after: BTreeMap<String, Resource>,
}

impl FixtureAccess {
    fn seeded() -> Self {
        let documents = [
            (
                "public/news",
                map(&[("title", "News".into()), ("published", true.into())]),
            ),
            (
                "tenants/tenant-a",
                map(&[("name", "Tenant A".into()), ("status", "active".into())]),
            ),
            (
                "tenants/tenant-a/members/alice",
                map(&[("role", "editor".into()), ("active", true.into())]),
            ),
            (
                "tenants/tenant-a/projects/project-1",
                project("alice", "Project", 1),
            ),
            (
                "tenants/tenant-a/projects/delete-admin",
                project("alice", "Delete", 1),
            ),
            (
                "tenants/tenant-a/projects/delete-member",
                project("alice", "Keep", 1),
            ),
            (
                "tenants/tenant-a/projects/project-1/tasks/task-1",
                task("alice", "Task", "open", 1),
            ),
            (
                "tenants/tenant-a/projects/project-1/tasks/task-update-allow",
                task("alice", "Task", "open", 1),
            ),
            (
                "tenants/tenant-a/projects/project-1/tasks/task-update-deny",
                task("alice", "Task", "open", 1),
            ),
            (
                "tenants/tenant-a/projects/project-1/tasks/task-1/comments/comment-1",
                map(&[("authorId", "alice".into()), ("body", "first".into())]),
            ),
            (
                "profiles/alice",
                map(&[("displayName", "Alice".into()), ("timezone", "UTC".into())]),
            ),
            (
                "tenants/tenant-a/assets/folder/deep/file",
                map(&[("kind", "file".into())]),
            ),
            ("stats/overview", map(&[("count", Value::Integer(1))])),
            ("invariants/global", map(&[("version", Value::Integer(1))])),
        ];
        let mut current = documents
            .into_iter()
            .map(|(path, data)| {
                let path = canonical(path);
                (path.clone(), Resource::new(path, data))
            })
            .collect::<BTreeMap<_, _>>();
        for index in 0..8 {
            let id = format!("{index:02}");
            let path = canonical(&format!("tenants/tenant-a/entity-{id}/document-{id}"));
            current.insert(
                path.clone(),
                Resource::new(path, project("alice", "unused", 1)),
            );
        }
        Self {
            current,
            after: BTreeMap::new(),
        }
    }
}

impl DocumentAccess for FixtureAccess {
    fn get(&self, path: &str) -> Result<Option<Resource>, DocumentAccessError> {
        Ok(self.current.get(path).cloned())
    }

    fn get_after(&self, path: &str) -> Result<Option<Resource>, DocumentAccessError> {
        Ok(self.after.get(path).cloned())
    }
}

fn canonical(path: &str) -> String {
    format!("{ROOT}/{path}")
}

fn request_time() -> Timestamp {
    Timestamp::parse_rfc3339("2026-09-01T09:00:00Z").expect("request timestamp")
}

fn auth(uid: &str, role: &str, tenant: &str) -> Auth {
    Auth {
        uid: uid.to_owned(),
        token: map(&[("role", role.into()), ("tenant_id", tenant.into())]),
    }
}

fn map(values: &[(&str, Value)]) -> BTreeMap<String, Value> {
    values
        .iter()
        .map(|(key, value)| ((*key).to_owned(), value.clone()))
        .collect()
}

fn project(owner: &str, title: &str, version: i64) -> BTreeMap<String, Value> {
    map(&[
        ("ownerId", owner.into()),
        ("title", title.into()),
        ("status", "active".into()),
        ("version", Value::Integer(version)),
    ])
}

fn task(assignee: &str, title: &str, status: &str, priority: i64) -> BTreeMap<String, Value> {
    map(&[
        ("assigneeId", assignee.into()),
        ("title", title.into()),
        ("status", status.into()),
        ("priority", Value::Integer(priority)),
    ])
}
