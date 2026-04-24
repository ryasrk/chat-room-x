# Employee Context Packets

Purpose:
- Provide isolated, execution-ready context for subagents assigned per employee.
- Reduce dependency on shared conversation state.

How to use:
1. Open the specific employee context file.
2. Copy the `Subagent Brief` section into the isolated subagent task prompt.
3. Include only listed files unless new dependency is discovered.
4. Validate with acceptance criteria in that context file.

Related planning docs:
- `docs/ROBUST_CHATBOT_ROADMAP.md`
- `docs/ROBUST_CHATBOT_TASK_BOARD.md`
- `docs/EMPLOYEE_SUPPLEMENT_RESEARCH.md`

Context files:
- `docs/employee-contexts/EMPLOYEE_1_STREAMING_RELIABILITY.md`
- `docs/employee-contexts/EMPLOYEE_2_SESSION_RECOVERY.md`
- `docs/employee-contexts/EMPLOYEE_3_CONTEXT_MEMORY_QUALITY.md`
- `docs/employee-contexts/EMPLOYEE_4_CONVERSATION_UX.md`
- `docs/employee-contexts/EMPLOYEE_5_GROUNDING_OBSERVABILITY.md`
