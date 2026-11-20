# AWS bootstrap (slime)

One-time layer that carves out the `slime` project inside the existing AWS
account (no AWS Organizations). Everything else in `infra/aws/` should run
through the role it creates.

| Resource | Purpose |
|---|---|
| IAM role `slime-deployer` | `AdministratorAccess` + `region-guard` deny: regional services only in `eu-central-1` |
| Resource group `slime` | Console view of all resources tagged `Project=slime` |
| Budget `slime-account-monthly` | Account-wide monthly cost alerts at 50% / 80% actual, 100% forecasted |

All resources carry `Project=slime`, `ManagedBy=terraform`, `Stack=aws-bootstrap`.
Later stacks must set `default_tags { tags = { Project = "slime" } }` so their
resources show up in the resource group.

## Apply

Runs with the admin profile (`default`), since the role does not exist yet.

```sh
cd infra/aws/bootstrap
cp terraform.tfvars.example terraform.tfvars   # fill in ARN + alert email
terraform init -backend-config="path=$HOME/.terraform-state/slime/aws-bootstrap.tfstate"
terraform apply
terraform output -raw aws_cli_profile >> ~/.aws/config   # once
aws sts get-caller-identity --profile slime
```

## Use

```sh
export AWS_PROFILE=slime
```

## State

State is local because this layer creates the identity everything else depends
on. It lives at `~/.terraform-state/slime/aws-bootstrap.tfstate`, outside the
repo, so `git worktree remove` cannot delete it; every fresh checkout must pass
the same `-backend-config` path to `terraform init`. If it is lost, re-import with
`terraform import` (role name, resource group name, `<account-id>:slime-account-monthly`).
