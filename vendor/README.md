# Reference clones

Local shallow clones for teardown and pattern comparison. **Not** dependencies of OpenRecord; do not import or ship in the product without a separate license review (`docs/external-repo-audit.md`).

| Directory | Remote | HEAD (when cloned) |
| --- | --- | --- |
| `treg/` | https://github.com/superdesigndev/treg | `8e402a0` |
| `t3code/` | https://github.com/pingdotgg/t3code | `41d5875e` |

Refresh:

```sh
git -C vendor/treg pull --ff-only
git -C vendor/t3code pull --ff-only
```

Deepen history if needed: `git fetch --unshallow` in either directory.