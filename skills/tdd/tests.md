# What a good test looks like

Integration-style, through the public interface, describing what the system does rather than
how. The name reads as a capability: "user can checkout with valid cart", not "checkout calls
paymentService.process".

The best template is not in this file. Open the nearest existing test in the same package and
mirror its harness, its fixtures, its setup helpers, and its naming. Match what is there rather
than importing a house style from elsewhere.

## Read back through the interface, not around it

Create through the public API, then read back through the public API. A test that writes through
the interface and verifies by querying storage directly will pass while the feature is unusable
to every real caller.

## Red flags

- mocking a collaborator you own
- asserting on call counts, argument order, or private methods
- a name that describes a mechanism instead of a capability
- the test breaks on a rename with no behavior change
- the assertion would have held before the feature existed

The last one is the one that matters, and reading the test will not tell you. Prove it with the
bite-check.

## One logical assertion

Several assertions describing one outcome are fine. Two unrelated outcomes in one test means a
failure tells you less than it should.
