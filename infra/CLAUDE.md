# infra

Terraform for the agent-place AWS deployment: one Lambda function
(`agent-place`, nodejs22.x/arm64) serving the API and viewer page behind a
public Function URL, one DynamoDB table (`agent-place`, on-demand, TTL on
`ttl`), the Terraform state backend, and the scoped `agent-place-ci` user that
GitHub Actions deploys with. Region: ap-southeast-2. Costs sit inside the
Lambda/DynamoDB free tiers at current traffic; `reserved_concurrent_executions
= 10` caps worst-case spend.

## State

Remote state in S3 (`s3://agent-place-tfstate/agent-place/terraform.tfstate`)
with S3 native locking (`use_lockfile`, no DynamoDB). The state bucket is
managed here with `prevent_destroy` - do not remove that lifecycle rule.

## Applying changes

Never apply locally. Push to main: `.github/workflows/deploy.yml` runs tests,
then `terraform plan -out` + `apply` with the `agent-place-ci` credentials
(GitHub Actions secrets `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`). Pull
requests run plan only. Local `terraform plan` for inspection is fine.

The Lambda code is part of this config (`archive_file` of `src/` +
`source_code_hash`), so app-code pushes redeploy through the same plan/apply
pipeline - there is no separate code-deploy path.

### Bootstrap (one-time, already done 2026-08-01)

The state bucket and CI user cannot create themselves. Bootstrap was: comment
out `backend.tf`, `terraform apply -target` of the tfstate bucket resources +
`agent-place-ci` user/policy with local state, restore `backend.tf`,
`terraform init -migrate-state`. Everything after that (table, Lambda, role,
logs, URL) was first applied by GitHub Actions. If re-bootstrapping from
scratch, repeat those steps.

### CI credentials (out-of-band, documented exception)

`agent-place-ci` access keys are intentionally not in Terraform state. Create
with:

```sh
doppler run --project global --config home -- aws iam create-access-key --user-name agent-place-ci
```

Store the key pair in the `agent-place` Doppler project (`prd` config) and as
GitHub Actions secrets on byronxlg/agent-place.
