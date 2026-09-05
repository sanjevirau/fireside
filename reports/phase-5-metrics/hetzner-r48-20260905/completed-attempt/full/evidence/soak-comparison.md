## Soak resource measurements

Swap activity is reported, not gated. No performance winner is required. Missing stacks are not measured, never zero.

| Measurement | Official | Fireside |
| --- | ---: | ---: |
| Swap-in pages | 499591 | 0 |
| Swap-out pages | 438844 | 0 |
| Residual swap at window start (bytes) | 13496057856 | 0 |
| Residual swap at window end (bytes) | 12597698560 | 0 |

Top processes ranked independently by per-PID maximum sampled PSS (not simultaneous totals):

| Rank | Official process | Peak PSS (bytes) | Fireside process | Peak PSS (bytes) |
| ---: | --- | ---: | --- | ---: |
| 1 | java (PID 599724) | 9342156800 | next-server (v1 (PID 77767) | 8702707712 |
| 2 | MainThread (PID 600716) | 2679262208 | fireside (PID 77728) | 5127376896 |
| 3 | next-server (v1 (PID 599598) | 1391630336 | MainThread (PID 78672) | 3504026624 |
| 4 | TwodartNet (PID 599953) | 559923200 | TwodartNet (PID 78061) | 629414912 |
| 5 | MainThread (PID 599537) | 272686080 | dotnet (PID 77976) | 371879936 |
| 6 | MainThread (PID 601687) | 164699136 | java (PID 77786) | 211698688 |
| 7 | MainThread (PID 602156) | 163798016 | MainThread (PID 80969) | 161350656 |
| 8 | MainThread (PID 602162) | 163603456 | MainThread (PID 81093) | 158503936 |
| 9 | dotnet (PID 599855) | 118595584 | MainThread (PID 81087) | 157404160 |
| 10 | java (PID 600034) | 95794176 | dotnet (PID 77768) | 123905024 |

