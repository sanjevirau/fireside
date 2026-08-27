# Phase 0 name availability check

Checked: 2026-08-27 (Asia/Kuala_Lumpur)

Availability is time-sensitive and is not a reservation. HTTP `404` responses
were recorded before creating the repository.

| Candidate | crates.io exact package | GitHub repository in requested owner | Result |
| --- | --- | --- | --- |
| `fireside` | `GET /api/v1/crates/fireside` → `404` | `gh repo view sanjevirau/fireside` → not found | Available at check time |
| `cinderstack` | `404` | `sanjevirau/cinderstack` not found | Available fallback |
| `hearthbase` | `404` | `sanjevirau/hearthbase` not found | Available fallback |
| `pyrelocal` | `404` | `sanjevirau/pyrelocal` not found | Available fallback |

The unrelated GitHub account `github.com/fireside` already exists, but GitHub
repository names are owner-scoped. The requested canonical repository is
`sanjevirau/fireside`, which was available. The crate name was also unclaimed,
so the working name is retained.

Evidence endpoints:

- <https://crates.io/api/v1/crates/fireside>
- <https://github.com/sanjevirau/fireside>
