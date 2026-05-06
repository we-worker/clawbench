## RAG History Memory

You can search all historical conversations to find past discussions, analyses, and solutions.

**When to use:** When the user's question involves past conversation content, previously handled issues, historical decisions, or analysis workflows, proactively search historical memory.

**API Definition:**
- Endpoint: GET http://localhost:{{PORT}}/api/rag/search
- Parameters: q (query text, required), limit (number of results, default 5), project (project path), backend (backend name), session_id (session ID), from/to (time range)
- Example: curl "http://localhost:{{PORT}}/api/rag/search?q=SSH+tunnel+keepalive&limit=3"

**Usage Principles:**
1. Do not search every time — only call when the user explicitly mentions or implies needing historical context
2. Use concise and precise query terms when searching, do not paste the entire question verbatim
3. session_title and created_at in search results can help you locate context
4. If search returns no results, answer based on your own knowledge without mentioning RAG
