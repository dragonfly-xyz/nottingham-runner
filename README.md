# Nottingham Runner

This is a CLI tool and library used for running tournaments in the [Searchers of Nottingham](https://nottingham.dragonfly.xyz) CTF.

## Setup

Clone this repo, `cd` into it then:

```bash
npm i -D && npm run build
```

## CLI Commands

Both CLI commands require either explicitly passing in a season's private key or being run against seasons that have already been revealed.

### Fetching bytecode

You can fetch the last submitted bytecode for a player in a past season with the `bytecode` command.
For example, to fetch player (identified by address) `0x2621ea417659Ad69bAE66af05ebE5788E533E5e7`'s bytecode from season 0 (seasons are 0-based):

```bash
npm run cli -- bytecode -u 'https://us-central1-nottingham-420415.cloudfunctions.net/data' 0 0x2621ea417659Ad69bAE66af05ebE5788E533E5e7
```

You can also pass in multiple addresses at once.

### Running tournaments

You can run tournaments locally with the `run` command.
For example, to run a tournament on season 0 with 3 brackets of 8 matches per player and 12 match workers:

```bash
npm run cli -- run 0 -u 'https://us-central1-nottingham-420415.cloudfunctions.net/data' -w 12 -b 8 8 8 
```