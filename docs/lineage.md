# Repository lineage

| Local checkout                              | GitHub                  | Role                                                          |
| ------------------------------------------- | ----------------------- | ------------------------------------------------------------- |
| `source/projects/temari-agent-orchestrator` | `randydinh/temari-v1`   | Historical orchestrator                                       |
| `source/projects/temari-core`               | `randydinh/temari-v2`   | v2.3 implementation                                           |
| `source/projects/temari-omega`              | `randydinh/temari-v3`   | Deprecated runtime                                            |
| `source/projects/temari-pstack`             | `randydinh/temari-v4`   | P-stack import precursor                                      |
| `source/projects/temari`                    | `randydinh/temari-v4.1` | Frozen plugin product until this repo passes the cutover gate |
| `source/projects/temari-next`               | `randydinh/temari`      | Canonical Nx platform                                         |
| `source/projects/temari-design`             | local only              | Owner deliberation; not coworker source of truth              |

Do not merge v1–v4 trees into this repository as live source. Extract
proven contracts, adapters, playbooks-as-plan-templates, and verification
fixtures only.
