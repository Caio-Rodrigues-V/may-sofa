# Sofas May Agent

Projeto independente de atendimento da Sofás May. A arquitetura técnica deriva do template anterior, mas nenhum catálogo, preço, mídia, regra comercial, prompt, migration, estado Redis ou configuração operacional daquele projeto é reutilizado.

## Preparação

1. Crie um projeto Supabase exclusivo e aplique `supabase/migrations/001_initial_schema.sql`.
2. Copie `.env.example` para `.env` e preencha somente credenciais da Sofás May.
3. Rode `npm run audit:isolation` e `npm test`.
4. Importe o conhecimento institucional com `node scripts/import-approved-knowledge.js`.
5. Cadastre produtos, variantes, preços e mídias com `review_status=approved` somente após validação humana.

O agente permanece desabilitado por padrão. Não defina `AGENT_ENABLED=true` antes de validar WTS, CRM, Supabase, Redis e OpenAI em ambiente isolado.
