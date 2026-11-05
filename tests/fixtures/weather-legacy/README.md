# Historical migration fixtures

These are **test data only**, never an installation source. `manifest.json` maps migration filenames at commits `de069c6bbecba6e933212f494d67a28f5c9d3b64` and `a8ce99cf277c34601a340cd7356e3e38df61eb51` to their SHA-256-named SQL files. Identical files are stored once. Some deliberately contain the old destructive logic and reward functions so actual historical upgrade paths can be reproduced. The tests execute historical files on empty disposable databases, seed legacy data at a selected prefix, then execute the complete corrected remaining migrations.

`../dev-points/` contains the three timestamped points migrations at dev commit `6a4798f5b490b49d4e2e5c950cabd706a1d5b036` for both SQL order compatibility tests. These fixtures are not modified to make the tests pass.
