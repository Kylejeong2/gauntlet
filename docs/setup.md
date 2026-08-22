# GitHub App setup

Gauntlet runs as a GitHub App. It does not use a personal access token and it does not ask for repository administration access.

## Prerequisites

- A public GitHub repository.
- Node.js 22 or newer.
- pnpm 10.15.0 through Corepack.
- A Sail API key with access to GPT-OSS 120B and Sailboxes.
- A public HTTPS webhook endpoint. A temporary Smee channel is suitable for local development.

## Create the app

Open GitHub **Settings > Developer settings > GitHub Apps > New GitHub App** and configure:

| Setting                               | Value                                                           |
| ------------------------------------- | --------------------------------------------------------------- |
| GitHub App name                       | A unique name such as `Gauntlet Review Dev`                     |
| Homepage URL                          | The public repository URL                                       |
| Webhook URL                           | Your deployed `/api/github/webhooks` URL or temporary proxy URL |
| Webhook secret                        | A new random value stored as `WEBHOOK_SECRET`                   |
| Repository permissions: Contents      | Read-only                                                       |
| Repository permissions: Pull requests | Read and write                                                  |
| Subscribe to events                   | Pull request                                                    |
| Where can this app be installed?      | Only on this account for a private development app              |

Gauntlet listens to `opened`, `reopened`, `ready_for_review`, and `synchronize`. Draft pull requests and private repositories are rejected before a Sail request or Sailbox creation.

Generate a private key after creating the app. Store its PEM contents as `PRIVATE_KEY`. Record the numeric App ID as `APP_ID`.

## Install dependencies

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

Copy `.env.example` to `.env` for local development and replace every placeholder. The application never reads or logs the file directly. Probot supplies GitHub authentication from `APP_ID`, `PRIVATE_KEY`, and `WEBHOOK_SECRET`; Gauntlet reads only the Sail key and database path from the process environment.

## Start locally

Build and start Probot:

```bash
pnpm build
pnpm start
```

Probot listens on port 3000 by default. For a temporary Smee endpoint:

```bash
npx smee-client --url https://smee.io/your-channel --path /api/github/webhooks --port 3000
```

Set the GitHub App webhook URL to the same Smee channel. Install the app on only the public repository used for testing. Opening or updating a non-draft pull request starts a review.

## Required environment

See [Configuration](configuration.md) for every value and the Sail contract. Never commit `.env`, a private key, a webhook secret, or a Sail key. The repository ignore rules cover `.env`, `.env.*`, and SQLite runtime files.

## Delivery and recovery

The webhook handler authenticates, validates, and durably queues an eligible run before returning. A leased worker drains accepted runs immediately and every five seconds. SQLite prevents duplicate delivery and duplicate owner/repository/pull/head runs, persists the immutable base and head target, and returns expired leases to the queue after process restart.

Every published review contains a stable run marker. If the process stops after GitHub accepts the review but before the local completion write, the recovered worker finds the marker and records the existing review ID instead of submitting a second review.
