"""Community intelligence scraper for Reddit, GitHub Issues, and Hacker News."""

import asyncio
import re
import httpx
from typing import Optional


HEADERS = {
    "User-Agent": "NetSpec-ResearchAgent/1.0 (networking spec generator; research bot)",
    "Accept": "application/json",
}

TIMEOUT = httpx.Timeout(15.0)
STAR_TIMEOUT = httpx.Timeout(4.0)  # fast timeout for star fetching


async def fetch_github_stars(client: httpx.AsyncClient, repo: str) -> Optional[int]:
    """Fetch star count for a GitHub repo (owner/repo format). Returns None on failure."""
    if not repo:
        return None
    # Keep only owner/repo (strip trailing paths)
    parts = repo.strip("/").split("/")
    if len(parts) < 2:
        return None
    repo_path = "/".join(parts[:2])
    try:
        resp = await client.get(
            f"https://api.github.com/repos/{repo_path}",
            headers={**HEADERS, "Accept": "application/vnd.github.v3+json"},
            timeout=STAR_TIMEOUT,
        )
        if resp.status_code == 200:
            return resp.json().get("stargazers_count")
    except Exception:
        pass
    return None


async def search_reddit(client: httpx.AsyncClient, query: str, limit: int = 5) -> list[dict]:
    try:
        url = "https://www.reddit.com/search.json"
        params = {"q": query, "sort": "relevance", "t": "all", "limit": limit, "type": "link"}
        resp = await client.get(url, params=params, headers=HEADERS, timeout=TIMEOUT)
        resp.raise_for_status()
        data = resp.json()
        items = []
        for post in data.get("data", {}).get("children", []):
            p = post.get("data", {})
            content = p.get("selftext", "") or p.get("title", "")
            if len(content) > 2000:
                content = content[:2000] + "..."
            items.append({
                "source": "reddit",
                "title": p.get("title", ""),
                "url": f"https://reddit.com{p.get('permalink', '')}",
                "content": content,
                "score": p.get("score", 0),
                "subreddit": p.get("subreddit", ""),
                "num_comments": p.get("num_comments", 0),
            })
        return items
    except Exception as e:
        return [{"source": "reddit", "title": f"Reddit search error: {e}", "url": "", "content": "", "score": 0}]


async def search_github(client: httpx.AsyncClient, query: str, token: str = "", limit: int = 5) -> list[dict]:
    try:
        url = "https://api.github.com/search/issues"
        params = {"q": f"{query} is:issue", "sort": "reactions", "order": "desc", "per_page": limit}
        headers = {**HEADERS, "Accept": "application/vnd.github.v3+json"}
        if token:
            headers["Authorization"] = f"token {token}"
        resp = await client.get(url, params=params, headers=headers, timeout=TIMEOUT)
        resp.raise_for_status()
        data = resp.json()
        items = []
        for issue in data.get("items", []):
            body = issue.get("body", "") or ""
            if len(body) > 2000:
                body = body[:2000] + "..."
            items.append({
                "source": "github",
                "title": issue.get("title", ""),
                "url": issue.get("html_url", ""),
                "content": body,
                "score": issue.get("reactions", {}).get("+1", 0) + issue.get("comments", 0),
                "repo": issue.get("repository_url", "").replace("https://api.github.com/repos/", ""),
                "state": issue.get("state", ""),
            })
        return items
    except Exception as e:
        return [{"source": "github", "title": f"GitHub search error: {e}", "url": "", "content": "", "score": 0}]


async def search_hn(client: httpx.AsyncClient, query: str, limit: int = 4) -> list[dict]:
    try:
        url = "https://hn.algolia.com/api/v1/search"
        params = {"query": query, "tags": "story", "hitsPerPage": limit}
        resp = await client.get(url, params=params, headers=HEADERS, timeout=TIMEOUT)
        resp.raise_for_status()
        data = resp.json()
        items = []
        for hit in data.get("hits", []):
            title = hit.get("title", hit.get("story_title", ""))
            content = hit.get("story_text", hit.get("comment_text", "")) or ""
            if len(content) > 1500:
                content = content[:1500] + "..."
            url_link = hit.get("url", "") or f"https://news.ycombinator.com/item?id={hit.get('objectID', '')}"
            items.append({
                "source": "hn",
                "title": title,
                "url": url_link,
                "content": content,
                "score": hit.get("points", 0) or 0,
                "num_comments": hit.get("num_comments", 0) or 0,
            })
        return items
    except Exception as e:
        return [{"source": "hn", "title": f"HN search error: {e}", "url": "", "content": "", "score": 0}]


async def scrape_all(queries: list[dict], github_token: str = "") -> list[dict]:
    """Run all scraping queries in parallel.

    Source priority (per SKILL Phase 5):
      1. github  — official open-source bug trackers (FRR, BIRD, OpenBGPD, SONiC, etc.)
      2. hn      — curated technical discussions (supplement only)
      3. reddit  — EXCLUDED by SKILL as "不合格來源" (anonymous forums)
                   Kept as last-resort fallback if no github/hn results found.
    """
    async with httpx.AsyncClient() as client:
        tasks_by_priority: list[tuple[int, any]] = []
        for q in queries:
            keyword = q["keyword"]
            source  = q["source"]
            if source == "github":
                tasks_by_priority.append((1, search_github(client, keyword, token=github_token)))
            elif source == "hn":
                tasks_by_priority.append((2, search_hn(client, keyword)))
            elif source == "reddit":
                tasks_by_priority.append((3, search_reddit(client, keyword)))

        tasks_by_priority.sort(key=lambda x: x[0])
        results = await asyncio.gather(*[t for _, t in tasks_by_priority], return_exceptions=True)

    all_items: list[dict] = []
    seen_urls: set[str] = set()
    github_count = 0
    for batch in results:
        if isinstance(batch, list):
            for item in batch:
                url = item.get("url", "")
                if not url or not item.get("title"):
                    continue
                if url in seen_urls:
                    continue
                if item.get("source") == "reddit" and github_count >= 5:
                    continue
                seen_urls.add(url)
                all_items.append(item)
                if item.get("source") == "github":
                    github_count += 1

    source_order = {"github": 0, "hn": 1, "reddit": 2}
    all_items.sort(key=lambda x: (source_order.get(x.get("source",""), 3), -x.get("score", 0)))
    all_items = all_items[:20]

    # NOTE: GitHub repo star counts are intentionally NOT fetched here — that was a
    # second serial HTTP round (up to ~4s/repo) gating the analyze step for a
    # display-only field that no LLM prompt consumes. Removed from the critical
    # path; fetch lazily via a separate endpoint if star display is ever needed.
    return all_items
