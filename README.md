# Sofas May Agent

Projeto independente de atendimento da Sofás May. A arquitetura técnica deriva do template anterior, mas nenhum catálogo, preço, mídia, regra comercial, prompt, migration, estado Redis ou configuração operacional daquele projeto é reutilizado.

## Preparação

1. Crie um projeto Supabase exclusivo e aplique `supabase/migrations/001_initial_schema.sql`.
2. Copie `.env.example` para `.env` e preencha somente credenciais da Sofás May.
3. Rode `npm run audit:isolation` e `npm test`.
4. Importe o conhecimento institucional com `node scripts/import-approved-knowledge.js`.
5. Cadastre produtos, variantes, preços e mídias com `review_status=approved` somente após validação humana.

O agente permanece desabilitado por padrão. Não defina `AGENT_ENABLED=true` antes de validar WTS, CRM, Supabase, Redis e OpenAI em ambiente isolado.

## Painel Smart Trigo

O agente é editado pelo painel (tenant `sofas-may`, prefixo `sofas_may_`):

- **Prompt:** lido de `sofas_may_prompt_versions` (`active = true`, mais recente) e guardado em memória. O painel chama `POST /internal/reload-prompt` (Bearer `WEBHOOK_SECRET`) ao publicar. `SYSTEM-PROMPT.txt` é só fallback se o Supabase falhar.
- **Conhecimento:** com `KNOWLEDGE_SEMANTIC_ENABLED=true`, busca semântica via `sofas_may_match_knowledge` nos cards que o painel salva com embedding; cai para busca por palavras se falhar.
- **Catálogo, preços e mídias:** lidos a cada mensagem, então aprovações no painel valem na hora.

Aplique `supabase/migrations/002_painel_compat.sql` e rode `npm run backfill:embeddings` para gerar embeddings dos cards antigos. O `WEBHOOK_SECRET` do agente deve ser igual ao `WEBHOOK_SECRET_SOFAS_MAY` do painel.
