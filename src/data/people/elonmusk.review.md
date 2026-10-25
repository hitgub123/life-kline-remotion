# 马斯克 · 事实核查报告

- 审查方：gemini/gemini-3.8-flash，对照维基资料 src/data/people/elonmusk.md
- 结论：发现 3 处问题；已自动修正 3 处

- [error] segments[4].quote：引句「绝境中，第一性原理是唯一解法」查无原话出处，系中文网络杜撰概括而非马斯克本人名言（依据：马斯克阐述第一性原理时原话为物理学视角的思维方式（'First principles is kind of a physics way of looking at the world...'），从未发表过该句）
- [error] segments[7].quote：引句「推特是一座没有围墙的广场」查无此据，与原话不符（依据：马斯克原话为「Twitter is the digital town square where matters vital to the future of humanity are debated」（推特是一个数字城市广场），并无「没有围墙的广场」之表达）
- [error] segments[8].quote：引句「造火箭很难，但把它造便宜更难」查无出处，非有据可查的马斯克名言（依据：马斯克虽强调过降低火箭成本与制造难度，但从未发表过此句特定名言）

## 已应用的修正
- segments.4.quote："绝境中，第一性原理是唯一解法" → null（查无原话出处，非本人名言）
- segments.7.quote："推特是一座没有围墙的广场" → null（查无此据，篡改自digital town square）
- segments.8.quote："造火箭很难，但把它造便宜更难" → null（查无原话出处，非本人名言）
