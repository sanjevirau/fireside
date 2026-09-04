## Soak resource measurements

Swap activity is reported, not gated. No performance winner is required. Missing stacks are not measured, never zero.

| Measurement | Official | Fireside |
| --- | ---: | ---: |
| Swap-in pages | 499591 | 83112 |
| Swap-out pages | 438844 | 234237 |
| Residual swap at window start (bytes) | 13496057856 | 7206957056 |
| Residual swap at window end (bytes) | 12597698560 | 7617699840 |

Top processes ranked independently by per-PID maximum sampled PSS (not simultaneous totals):

| Rank | Official process | Peak PSS (bytes) | Fireside process | Peak PSS (bytes) |
| ---: | --- | ---: | --- | ---: |
| 1 | java (PID 599724) | 9342156800 | next-server (v1 (PID 691241) | 4279030784 |
| 2 | MainThread (PID 600716) | 2679262208 | fireside (PID 691190) | 3544293376 |
| 3 | next-server (v1 (PID 599598) | 1391630336 | MainThread (PID 692969) | 2920765440 |
| 4 | TwodartNet (PID 599953) | 559923200 | TwodartNet (PID 691510) | 605915136 |
| 5 | MainThread (PID 599537) | 272686080 | MainThread (PID 695326) | 163362816 |
| 6 | MainThread (PID 601687) | 164699136 | MainThread (PID 695570) | 161572864 |
| 7 | MainThread (PID 602156) | 163798016 | MainThread (PID 695563) | 161268736 |
| 8 | MainThread (PID 602162) | 163603456 | java (PID 691201) | 100876288 |
| 9 | dotnet (PID 599855) | 118595584 | dotnet (PID 691242) | 70048768 |
| 10 | java (PID 600034) | 95794176 | dotnet (PID 691441) | 50759680 |

