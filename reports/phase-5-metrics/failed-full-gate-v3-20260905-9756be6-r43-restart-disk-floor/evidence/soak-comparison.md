## Soak resource measurements

Swap activity is reported, not gated. No performance winner is required. Missing stacks are not measured, never zero.

| Measurement | Official | Fireside |
| --- | ---: | ---: |
| Swap-in pages | 499591 | 55768 |
| Swap-out pages | 438844 | 193395 |
| Residual swap at window start (bytes) | 13496057856 | 7444135936 |
| Residual swap at window end (bytes) | 12597698560 | 7800147968 |

Top processes ranked independently by per-PID maximum sampled PSS (not simultaneous totals):

| Rank | Official process | Peak PSS (bytes) | Fireside process | Peak PSS (bytes) |
| ---: | --- | ---: | --- | ---: |
| 1 | java (PID 599724) | 9342156800 | fireside (PID 768608) | 6257778688 |
| 2 | MainThread (PID 600716) | 2679262208 | next-server (v1 (PID 768625) | 3737193472 |
| 3 | next-server (v1 (PID 599598) | 1391630336 | MainThread (PID 770044) | 2911754240 |
| 4 | TwodartNet (PID 599953) | 559923200 | TwodartNet (PID 768927) | 606783488 |
| 5 | MainThread (PID 599537) | 272686080 | MainThread (PID 772441) | 163073024 |
| 6 | MainThread (PID 601687) | 164699136 | MainThread (PID 774925) | 161064960 |
| 7 | MainThread (PID 602156) | 163798016 | MainThread (PID 772602) | 159992832 |
| 8 | MainThread (PID 602162) | 163603456 | MainThread (PID 772603) | 159603712 |
| 9 | dotnet (PID 599855) | 118595584 | java (PID 768633) | 103894016 |
| 10 | java (PID 600034) | 95794176 | dotnet (PID 768646) | 72430592 |

