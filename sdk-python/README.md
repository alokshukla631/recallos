# RecallOS Python SDK

Python client for the [RecallOS](https://github.com/alokshukla631/recallos) API.

## Install

```bash
pip install -e sdk-python/
```

## Quick start

```python
from recallos import RecallOS

client = RecallOS()  # defaults to http://localhost:3001

# Check backend is running
print(client.health())

# Search memory
results = client.search_memory("window seat")
for item in results:
    print(f"  {item['key']}: {item['value']} (score: {item['search_score']:.3f})")

# Get compiled context for a message
ctx = client.get_context("Book me a flight to Tokyo")
print(ctx["context"])

# Chat through the full pipeline
response = client.chat("I prefer aisle seats now", provider="openai")
print(response["assistant_message"]["content"])

# List trips
trips = client.list_trips()

# Export/import passport
passport = client.export_passport()
client.import_passport(passport)

# Scrape local AI tool logs
sources = client.scraper_sources()
result = client.scraper_run()
```

## Async usage

```python
import asyncio
from recallos import AsyncRecallOS

async def main():
    async with AsyncRecallOS() as client:
        results = await client.search_memory("budget")
        print(results)

asyncio.run(main())
```

## API coverage

The SDK wraps all RecallOS REST endpoints:

- Memory: list, get, search, update, delete
- Session: stats, cleanup
- Context: benchmark (compile without provider call)
- Chat: full pipeline with provider
- Trips: list, create, delete
- Passport: export, import
- Scraper: sources, run
- Audit: recent log
- Tags: list, add
- Links: get, create
- MCP: config, install
