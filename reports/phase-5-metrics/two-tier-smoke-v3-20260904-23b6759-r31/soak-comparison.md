## Soak resource measurements

Swap activity is reported, not gated. No performance winner is required. Missing stacks are not measured, never zero.

| Measurement | Official | Fireside |
| --- | ---: | ---: |
| Swap-in pages | 1232 | 58 |
| Swap-out pages | 0 | 0 |
| Residual swap at window start (bytes) | 1180467200 | 518656000 |
| Residual swap at window end (bytes) | 1139404800 | 518635520 |

Top processes ranked independently by per-PID maximum sampled PSS (not simultaneous totals):

| Rank | Official process | Peak PSS (bytes) | Fireside process | Peak PSS (bytes) |
| ---: | --- | ---: | --- | ---: |
| 1 | next-server (v1 (PID 310526) | 7867446272 | next-server (v1 (PID 313765) | 8707793920 |
| 2 | java (PID 310644) | 681331712 | TwodartNet (PID 314189) | 449987584 |
| 3 | TwodartNet (PID 311000) | 438930432 | dotnet (PID 314020) | 376548352 |
| 4 | dotnet (PID 310796) | 310562816 | MainThread (PID 314647) | 160663552 |
| 5 | MainThread (PID 310467) | 285518848 | MainThread (PID 314743) | 157336576 |
| 6 | java (PID 310852) | 194922496 | MainThread (PID 314749) | 157192192 |
| 7 | MainThread (PID 312063) | 160156672 | java (PID 313753) | 140015616 |
| 8 | MainThread (PID 312863) | 157894656 | dotnet (PID 313786) | 117602304 |
| 9 | MainThread (PID 312869) | 157821952 | MainThread (PID 313892) | 100699136 |
| 10 | java (PID 310911) | 109963264 | MainThread (PID 314167) | 92590080 |

