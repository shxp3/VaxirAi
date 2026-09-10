Build a production-ready Discord AI bot called **Vaxir AI**.

The goal is to create a Discord bot that allows users in a community/server to chat with an LLM, ask general questions, ask coding questions, and maintain conversation context.

Do not build a portfolio description. Build the actual working project.

## Core Requirements

### 1. Discord Bot

Vaxir AI must support:

- `/ask <message>` — ask the AI a question
- `/clear` — clear the user's conversation context
- `/status` — show current AI provider/model status
- `/setup` — server administrator configuration
- Mentioning the bot, e.g. `@Vaxir AI explain recursion in Java`
- Configurable AI channel where users can chat naturally without using `/ask`

Only respond automatically in configured AI channels or when the bot is explicitly mentioned.

Do not respond to every message in the entire server.

### 2. Multi-provider AI architecture

Do NOT tightly couple the bot to one AI provider.

Create a provider abstraction such as:

```text
AIProvider
├── GeminiProvider
├── GroqProvider
├── OpenRouterProvider
└── OpenAICompatibleProvider
```

The bot should communicate with providers through a common interface.

Example concept:

```text
generate(messages, model, settings)
```

The exact implementation is up to you.

The architecture must make it easy to add another provider later without rewriting the Discord bot.

### 3. Server-owned API keys

Each Discord server should optionally be able to configure its own AI provider and API key.

Only users with appropriate Discord administrator permissions may configure this.

Example configuration:

```text
Provider:
- Gemini
- Groq
- OpenRouter
- Custom OpenAI-compatible

API Key:
<secret>

Model:
<model name>

Base URL:
<optional, only for custom provider>
```

Do NOT expose API keys in Discord messages, logs, error messages, or `/status`.

Never store API keys as plaintext if avoidable.

Use secure secret storage/encryption appropriate for the deployment environment.

### 4. Default Vaxir AI provider

If a server does not configure its own API key, Vaxir AI should use the default provider configured by the bot owner.

The architecture should support:

```text
Server API configuration
        ↓
If configured → use server provider
        ↓
Otherwise → use Vaxir default provider
```

The default provider must be configurable through environment variables/secrets.

Do not hardcode API keys.

### 5. Rate-limit handling

This is very important.

When an AI provider returns a rate-limit/quota error such as HTTP 429:

- Detect it cleanly.
- Do not crash the bot.
- Do not expose raw API errors.
- Tell the user that the AI provider is temporarily unavailable because its usage limit has been reached.

Example:

```text
⚠️ Vaxir AI is temporarily unavailable.

The current AI provider has reached its usage limit.
Please try again later.
```

If the provider gives retry information such as `Retry-After`, use it when appropriate.

Design the provider interface so automatic fallback can be added later.

For the first version, it is acceptable to report the limit instead of automatically switching providers.

### 6. Vaxir-side rate limiting

Implement rate limiting separate from the AI provider's limits.

Example defaults:

```text
5 requests / minute / user
```

Make these values configurable.

Prevent one user from consuming the entire provider quota.

Return a friendly message when the user is rate limited.

### 7. Conversation memory

Implement conversation context.

The bot should remember recent messages for each conversation.

Do NOT send the entire Discord server history to the AI.

Use a configurable context window, for example:

```text
last 10–20 messages
```

Conversation context should be separated by:

```text
Discord server
→ channel
→ user/conversation
```

`/clear` should remove the user's current conversation context.

Design the memory layer so it can later be backed by a persistent database.

### 8. AI channel

Allow server administrators to configure a channel as the AI channel.

Example:

```text
/setup ai-channel #ai-chat
```

Inside that channel:

```text
User:
how do I make a Discord bot in Java?

Vaxir AI:
...
```

No mention or slash command should be required in the configured AI channel.

Outside the configured channel, Vaxir should only respond when explicitly invoked.

### 9. Admin configuration

Create administrator-only configuration commands.

At minimum:

```text
/setup
/status
```

The setup system should allow administrators to configure:

- AI provider
- AI model
- API key
- custom OpenAI-compatible base URL
- AI channel
- user rate limit
- context/message limit
- enable/disable AI

Do not allow normal users to modify server configuration.

### 10. Status

`/status` should show useful non-sensitive information:

```text
Vaxir AI
Provider: Gemini
Model: ...
AI Channel: #ai-chat
Status: Online
Rate Limit: 5 requests/minute
Memory: Enabled
```

Never display:

- API keys
- authorization headers
- secrets
- internal tokens

### 11. Error handling

Handle at least:

- AI timeout
- AI provider unavailable
- HTTP 429
- invalid API key
- invalid model
- malformed provider response
- Discord API errors
- empty user messages
- excessively long prompts

Errors should be converted into understandable user-facing messages.

Detailed technical errors may be logged server-side, but never expose secrets.

### 12. Security

Treat all Discord user input as untrusted.

Implement:

- input length limits
- rate limiting
- permission checks
- secret protection
- safe logging
- no API-key leakage
- no stack traces sent to Discord

Do not execute code generated by the AI.

If the AI generates code, return it as text/code blocks only.

### 13. Database

Start with a simple persistence layer.

Store things such as:

```text
server settings
AI provider configuration
AI channel
rate-limit configuration
conversation metadata
conversation messages
```

Keep the database layer abstract so the implementation can later move between SQLite, PostgreSQL, or Cloudflare D1 without rewriting the rest of the application.

If the chosen deployment environment makes SQLite unsuitable, choose an appropriate free persistent database.

### 14. Deployment

The final bot must be capable of running 24/7 on a free hosting solution where possible.

Research the current free hosting options before choosing one.

Do not assume that a service is permanently free.

Prefer a deployment architecture that does not require the user's personal PC to remain powered on.

If Discord Gateway requires a persistent process for the selected implementation, choose hosting accordingly.

If a serverless architecture is used, ensure the Discord interaction model is actually compatible with it.

### 15. Technology choice

Choose the technology stack based on what is most practical for a reliable Discord bot and free deployment.

You may use:

- TypeScript/Node.js
- Python
- Kotlin/Java

Prefer TypeScript/Node.js if it significantly simplifies Discord integration and deployment.

Do not choose a technology merely because it sounds impressive.

### 16. Project structure

Use a clean structure similar to:

```text
vaxir-ai/
├── src/
│   ├── bot/
│   ├── commands/
│   ├── ai/
│   │   ├── AIProvider
│   │   ├── GeminiProvider
│   │   ├── GroqProvider
│   │   ├── OpenRouterProvider
│   │   └── OpenAICompatibleProvider
│   ├── memory/
│   ├── database/
│   ├── config/
│   ├── rate-limit/
│   └── utils/
├── tests/
├── .env.example
├── README.md
├── package.json / equivalent
└── deployment configuration
```

You may change the structure if there is a better architecture.

Keep responsibilities separated.

### 17. Environment variables

Create a `.env.example`.

Never put real secrets in the repository.

Example:

```text
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DEFAULT_AI_PROVIDER=
DEFAULT_AI_MODEL=
DEFAULT_AI_API_KEY=
DATABASE_URL=
```

Add appropriate variables depending on the chosen providers and deployment platform.

### 18. README

Write a practical README containing:

1. What Vaxir AI does
2. Features
3. Requirements
4. Local setup
5. Creating the Discord application
6. Configuring AI
7. Environment variables
8. Running locally
9. Deploying
10. Adding another AI provider
11. Troubleshooting

Do not use exaggerated marketing language.

Keep the README technical and factual.

### 19. Development approach

Do not attempt to implement every feature blindly in one giant step.

Work in phases:

#### Phase 1
- Discord bot
- `/ask`
- one AI provider
- basic error handling

#### Phase 2
- mentions
- AI channel
- conversation memory
- `/clear`

#### Phase 3
- provider abstraction
- Gemini
- Groq
- OpenRouter
- custom OpenAI-compatible provider

#### Phase 4
- server configuration
- API key management
- permissions
- rate limiting

#### Phase 5
- persistence
- deployment
- production error handling
- tests

After each phase, verify that the application still works.

### 20. Important instructions

Before writing significant code:

1. Inspect the current project directory.
2. Determine whether an existing project should be reused or whether this is a new project.
3. Check current official documentation for Discord and the selected AI providers.
4. Verify current free-tier/rate-limit/deployment limitations instead of relying on old information.
5. Choose the simplest architecture that satisfies the requirements.

Do not invent APIs, SDK methods, models, or free-tier limits.

When an API/provider is unavailable or its free tier has changed, adapt the implementation rather than pretending it is unlimited.

### 21. Definition of done

Do not say the project is complete unless:

- The bot can connect to Discord.
- `/ask` works.
- At least one real AI provider works.
- AI errors are handled.
- Rate limits are handled.
- API keys are not exposed.
- Conversation memory works.
- `/clear` works.
- Admin-only configuration works.
- The project can be started from a clean environment using the README.
- `.env.example` exists.
- The project has been tested locally.
- Deployment instructions are accurate for the selected platform.

If something cannot be tested because credentials or external services are unavailable, clearly state what could not be tested instead of claiming it works.

Start by inspecting the current workspace and then propose the implementation plan before making large changes.