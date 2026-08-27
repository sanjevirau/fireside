# Phase 1 cloud preflight

Checked: 2026-08-27 (Asia/Kuala_Lumpur)

This report records authorization to begin Phase 1. It is not a Phase 1 gate
report and makes no compatibility claim.

## Dedicated target

- Project ID: `fireside-conformance`
- Project name: `Fireside Conformance`
- Billing: enabled
- Budget: monthly RM50, alert thresholds 50%, 90%, and 100% (maintainer-provided
  Google Cloud Console evidence)
- Required APIs: `firestore.googleapis.com` and
  `firebaserules.googleapis.com` enabled
- Application Default Credentials: login completed; ADC quota project is
  `fireside-conformance`

## Databases and cleanup

| Database | Mode | Edition | Location | TTL policy |
| --- | --- | --- | --- | --- |
| `(default)` | Firestore Native | Standard | `nam5` | active |
| `fireside-conformance` | Firestore Native | Standard | `nam5` | active |

Both databases apply TTL to
`fireside_conformance._fireside_expires_at`. Tests also delete their own data
immediately; TTL is a crash/interruption backstop.

## Safety boundary

The harness hardcodes `fireside-conformance` as the only cloud target accepted
by this checkout and additionally requires two matching environment values. A
set `FIRESTORE_EMULATOR_HOST` is rejected for cloud runs. The existing gcloud
default project is not accepted and was not modified during provisioning.

## First production oracle check

The shared SDK smoke case passed against both targets on 2026-08-27:

| Target | Result | Scope |
| --- | ---: | --- |
| Production project `fireside-conformance` | 1/1 pass | one TTL-stamped synthetic write, read, delete, and absent read |
| Official Java emulator v1.22.0 | 1/1 pass | identical test body and SDK |

The client was `@google-cloud/firestore@9.0.0`. The production document used a
random ID in the `fireside_conformance` collection group and was deleted by the
test; active TTL remains the fallback. This establishes harness connectivity
only and is not a fireside compatibility result.
