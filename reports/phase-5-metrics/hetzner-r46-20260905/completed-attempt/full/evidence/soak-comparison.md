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
| 1 | java (PID 599724) | 9342156800 | next-server (v1 (PID 30213) | 8663028736 |
| 2 | MainThread (PID 600716) | 2679262208 | fireside (PID 30182) | 6002813952 |
| 3 | next-server (v1 (PID 599598) | 1391630336 | MainThread (PID 31079) | 3114465280 |
| 4 | TwodartNet (PID 599953) | 559923200 | TwodartNet (PID 30510) | 614182912 |
| 5 | MainThread (PID 599537) | 272686080 | dotnet (PID 30417) | 380466176 |
| 6 | MainThread (PID 601687) | 164699136 | java (PID 30231) | 208475136 |
| 7 | MainThread (PID 602156) | 163798016 | MainThread (PID 33484) | 161985536 |
| 8 | MainThread (PID 602162) | 163603456 | MainThread (PID 33628) | 158581760 |
| 9 | dotnet (PID 599855) | 118595584 | MainThread (PID 33634) | 158242816 |
| 10 | java (PID 600034) | 95794176 | dotnet (PID 30212) | 126245888 |

