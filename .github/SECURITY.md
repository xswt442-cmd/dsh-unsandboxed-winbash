# Security policy

## Supported versions

Security fixes ship as a new version on the current release line. `package.json` and the newest GitHub release identify that line. Older releases receive no fixes.

## Reporting

Open an issue that only asks for a preferred security contact. Keep exploit details, reproduction steps for an unfixed weakness, credentials, and private host information out of that issue; provide them through the contact the maintainer names in reply.

A report names the affected version, the affected component, the observed behavior, and the steps that reproduce it.

## Scope

Command execution outside the file sandbox, parent-environment scrubbing, process-tree termination, and timeout handling belong to this repository. Weaknesses in the host application or in a third-party dependency belong to that project's reporting channel.

## Handling

Maintainers answer the contact request, assess each finding against the current release line, and record a confirmed fix in the release notes of the version that ships it. Report details stay out of public issues until that release is published.
