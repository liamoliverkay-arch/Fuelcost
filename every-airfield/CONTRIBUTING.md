# Contributing

Thanks for helping! Anyone can suggest a change.

1. Click **Fork** at the top of this repository to get your own copy.
2. Make your change, then run the checks:
   ```bash
   python3 tools/csp.py            # needed after any change to the script in index.html
   tests/run.sh                    # browser and server tests
   deno test -A supabase/tests/    # only if you changed supabase/
   ```
3. Open a **pull request**. The security checks run automatically, and the owner reviews it before it goes live.

Please don't:

- put keys, passwords or tokens in any file;
- load scripts, fonts or data from new websites (the Content Security Policy will block them anyway);
- weaken a rule in [SECURITY.md](SECURITY.md) without explaining why in the pull request.

Found a security problem? Don't open an issue; report it privately as described in [SECURITY.md](SECURITY.md).
