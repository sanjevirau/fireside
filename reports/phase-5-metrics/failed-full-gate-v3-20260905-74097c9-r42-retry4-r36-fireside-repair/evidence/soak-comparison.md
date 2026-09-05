## Soak resource measurements

Swap activity is reported, not gated. No performance winner is required. Missing stacks are not measured, never zero.

| Measurement | Official | Fireside |
| --- | ---: | ---: |
| Swap-in pages | 499591 | 144750 |
| Swap-out pages | 438844 | 648653 |
| Residual swap at window start (bytes) | 13496057856 | 7437119488 |
| Residual swap at window end (bytes) | 12597698560 | 9247547392 |

Top processes ranked independently by per-PID maximum sampled PSS (not simultaneous totals):

| Rank | Official process | Peak PSS (bytes) | Fireside process | Peak PSS (bytes) |
| ---: | --- | ---: | --- | ---: |
| 1 | java (PID 599724) | 9342156800 | fireside (PID 747780) | 5034161152 |
| 2 | MainThread (PID 600716) | 2679262208 | next-server (v1 (PID 747837) | 4023461888 |
| 3 | next-server (v1 (PID 599598) | 1391630336 | MainThread (PID 749246) | 3005524992 |
| 4 | TwodartNet (PID 599953) | 559923200 | TwodartNet (PID 748094) | 534224896 |
| 5 | MainThread (PID 599537) | 272686080 | MainThread (PID 753442) | 162033664 |
| 6 | MainThread (PID 601687) | 164699136 | MainThread (PID 751624) | 160599040 |
| 7 | MainThread (PID 602156) | 163798016 | MainThread (PID 751794) | 158680064 |
| 8 | MainThread (PID 602162) | 163603456 | MainThread (PID 751795) | 158408704 |
| 9 | dotnet (PID 599855) | 118595584 | java (PID 747788) | 107174912 |
| 10 | java (PID 600034) | 95794176 | dotnet (PID 747823) | 74494976 |

