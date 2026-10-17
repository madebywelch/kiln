# Contributing

KILN is **issue-first**. Please do not open a pull request.

## Open an issue

Anyone with a GitHub account can open an issue on the public repository. Choose
the bug-report or feature-request template and include enough detail for the
change to be evaluated without a follow-up interview:

- The version or commit you are running.
- A minimal reproduction: a workflow, API request, or repository fixture.
- Expected and actual behavior, including the relevant run status and logs with
  secrets removed.
- For a feature, the problem first, then the smallest behavior change that
  solves it and any effect on durability, trust boundaries, concurrency,
  publication, or backward compatibility.

Do not include bearer tokens, provider keys, private source code, or personal
infrastructure details. Report security issues privately through
[SECURITY.md](SECURITY.md), never in a public issue.

## Pull requests

Unsolicited pull requests are closed without review. This is deliberate:

- The graph, persistence, and publication rules are load-bearing and require
  context that is hard to recover from a large diff.
- The maintainers implement accepted changes so the trust model and test
  evidence stay coherent.
- Bulk or AI-generated changes are not reviewed.

If a maintainer wants a specific contribution, they will say so on the issue and
define the scope there. Do not open a PR speculatively.

## Development

The project remains buildable and testable for anyone who wants to understand
it or reproduce a report:

```sh
make check
```

`make check` runs formatting, vet, race tests, a build, and example validation.
For the real-Pi integration test against a local inference fixture:

```sh
npm ci --prefix harness
PATH="$PWD/harness/node_modules/.bin:$PATH" KILN_PI_INTEGRATION=1 make check
```

Live provider tests are opt-in and billable. They are documented in
[testing](docs/TESTING.md); never add live credentials to CI or an issue.

Useful references:

- [Architecture](docs/ARCHITECTURE.md)
- [Workflow reference](docs/WORKFLOWS.md)
- [API guide](docs/API.md)

## License

Accepted changes become part of the project under the [MIT License](LICENSE).
No contributor agreement is required.
