# AWS bootstrap (slime)

One-time layer that carves out the `slime` project inside the existing AWS
account (no AWS Organizations). Everything else in `infra/aws/` should run
through the role it creates.

| Resource | Purpose |
|---|---|
| IAM role `slime-deployer` | `AdministratorAccess` + `region-guard` deny: regional services only in `eu-central-1` |
| Resource group `slime` | Console view of all resources tagged `Project=slime` |
| Budget `slime-monthly` | Project budget: $15/month on `eu-central-1` spend; alerts at $10.50 actual, $15 actual, $15 forecasted |
| Budget `slime-account-monthly` | Account-wide backstop ($100): alerts at 50% / 80% actual, 100% forecasted |
| S3 bucket `slime-tfstate-<account>` | Remote state for every slime stack; versioned, SSE-S3, public access blocked, TLS-only, native lockfile |
| IAM role `slime-gha-plan` | GitHub OIDC, PRs only: `ReadOnlyAccess` + state read + lockfile write |
| IAM role `slime-gha-apply` | GitHub OIDC, `main` only: `AdministratorAccess` minus IAM outside `slime-*`, bootstrap identities, state-bucket config, budgets |

Both CI roles also carry `region-guard` and a project scope that denies S3,
Secrets Manager, and SSM reads outside `slime-*` names. The GitHub OIDC
provider itself is owned by the ex-infra repository and is only read here.
CI never applies this stack: it owns the CI roles.

The project budget filters by region, not by tag: the account carries unrelated
spend (domain, Route 53, tax), and the `Project` cost-allocation tag can only be
activated after first tagged usage. Budgets alert only; they do not stop spend.

All resources carry `Project=slime`, `ManagedBy=terraform`, `Stack=aws-bootstrap`.
Later stacks must set `default_tags { tags = { Project = "slime" } }` so their
resources show up in the resource group.

## Apply

Runs with the admin profile (`default`), since it manages the roles everything
else uses.

```sh
cd infra/aws/bootstrap
cp terraform.tfvars.example terraform.tfvars   # fill in ARN + alert email
terraform init
terraform apply
terraform output -raw aws_cli_profile >> ~/.aws/config   # once
aws sts get-caller-identity --profile slime
```

## Use

```sh
export AWS_PROFILE=slime
```

## State

State is in `s3://slime-tfstate-025772230981/bootstrap/terraform.tfstate`
(lockfile locking). The stack creates its own bucket, so it was first applied
with local state and then migrated with `terraform init -migrate-state`. The
old local file is kept at `~/.terraform-state/slime/*.MIGRATED-TO-S3` as a
read-only backup; do not init against it.

Recovering from a deleted bucket: re-create it with local state
(`terraform init -backend=false` is not enough; temporarily switch the backend
to `local`), `terraform import` everything (role names, resource group,
`<account-id>:slime-account-monthly`, `<account-id>:slime-monthly`, bucket
name), then migrate back.
