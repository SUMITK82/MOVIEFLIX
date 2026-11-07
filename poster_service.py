import json
import re
import threading
import time
from functools import lru_cache
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen


COMMONS_API = "https://commons.wikimedia.org/w/api.php"
WIKIPEDIA_SUMMARY_API = "https://en.wikipedia.org/api/rest_v1/page/summary"
USER_AGENT = "MOVIEFLIXMovieDiscovery/1.0 (local movie website)"
_request_lock = threading.Lock()
_last_request_time = 0.0
_MIN_REQUEST_INTERVAL = 0.2
IGNORED_TITLE_WORDS = {"a", "an", "and", "of", "the"}
UNRELATED_POSTER_WORDS = {
    "crew",
    "exhibition",
    "exhibit",
    "logo",
    "museum",
    "teaser",
    "tour",
    "word",
}


def _request_commons(params):
    url = f"{COMMONS_API}?{urlencode(params)}"
    request = Request(url, headers={"User-Agent": USER_AGENT})
    return _open_json(request)


def _request_wikipedia_summary(title):
    slug = quote(title.replace(" ", "_"), safe="():,_")
    request = Request(
        f"{WIKIPEDIA_SUMMARY_API}/{slug}",
        headers={"User-Agent": USER_AGENT},
    )
    return _open_json(request)


def _open_json(request):
    global _last_request_time
    for attempt in range(3):
        with _request_lock:
            delay = _MIN_REQUEST_INTERVAL - (time.monotonic() - _last_request_time)
            if delay > 0:
                time.sleep(delay)
            try:
                with urlopen(request, timeout=12) as response:
                    result = json.loads(response.read().decode("utf-8"))
            except HTTPError as error:
                if error.code != 429 or attempt == 2:
                    raise
                retry_after = error.headers.get("Retry-After", "")
                wait = float(retry_after) if retry_after.isdigit() else 0.8 * (attempt + 1)
                _last_request_time = time.monotonic() + wait - _MIN_REQUEST_INTERVAL
                continue
            _last_request_time = time.monotonic()
            return result


def _normalized_words(value):
    return set(re.findall(r"[a-z0-9]+", value.lower()))


@lru_cache(maxsize=512)
def find_movie_poster(title, year=None):
    variants = [title, f"{title} (film)"]
    if year:
        variants.append(f"{title} ({year} film)")

    for candidate in dict.fromkeys(variants):
        try:
            page = _request_wikipedia_summary(candidate)
        except HTTPError as error:
            if error.code == 404:
                continue
            raise

        description = page.get("description", "").lower()
        if page.get("type") == "disambiguation":
            continue
        if not any(term in description for term in ("film", "movie")):
            continue
        if year and str(year) not in description and str(year) not in page.get(
            "title", ""
        ):
            continue

        image = page.get("thumbnail") or page.get("originalimage")
        image_url = image.get("source") if isinstance(image, dict) else None
        source_url = (
            page.get("content_urls", {}).get("desktop", {}).get("page")
            or page.get("content_urls", {}).get("mobile", {}).get("page")
        )
        if image_url and source_url:
            return {
                "url": image_url,
                "source_url": source_url,
                "license": "",
                "artist": "",
                "provider": "Wikipedia",
            }

    return _find_commons_poster(title, year)


def _find_commons_poster(title, year=None):
    title_words = _normalized_words(title) - IGNORED_TITLE_WORDS
    if not title_words:
        return None

    search_result = _request_commons(
        {
            "action": "query",
            "list": "search",
            "srnamespace": 6,
            "srlimit": 20,
            "srsearch": f'intitle:"{title}" poster',
            "format": "json",
        }
    )
    candidates = []
    for result in search_result.get("query", {}).get("search", []):
        file_title = result.get("title", "")
        file_words = _normalized_words(file_title)
        if (
            "poster" not in file_words
            or not title_words.issubset(file_words)
            or file_words.intersection(UNRELATED_POSTER_WORDS)
        ):
            continue
        file_years = {
            int(word) for word in file_words
            if len(word) == 4 and word.isdigit() and 1880 <= int(word) <= 2100
        }
        if year and file_years and year not in file_years:
            continue
        if len(title_words) == 1 and year not in file_years:
            continue
        candidates.append((result, file_years))

    if not candidates:
        return None

    candidates.sort(
        key=lambda candidate: (
            year in candidate[1] if year else False,
            -len(candidate[0].get("title", "")),
        ),
        reverse=True,
    )
    candidate_years = {
        candidate[0]["title"]: candidate[1] for candidate in candidates
    }
    image_result = _request_commons(
        {
            "action": "query",
            "titles": "|".join(candidate_years),
            "prop": "imageinfo",
            "iiprop": "url|extmetadata",
            "iiurlwidth": 900,
            "format": "json",
        }
    )
    pages = image_result.get("query", {}).get("pages", {})
    for page in pages.values():
        file_years = candidate_years.get(page.get("title"), set())
        image_info = (page.get("imageinfo") or [{}])[0]
        image_url = image_info.get("thumburl") or image_info.get("url")
        if not image_url:
            continue
        metadata = image_info.get("extmetadata", {})

        def metadata_value(key):
            value = metadata.get(key, {}).get("value", "")
            return re.sub(r"<[^>]*>", "", value).strip()

        if year and year not in file_years:
            description = " ".join(
                metadata_value(key)
                for key in ("Date", "ImageDescription", "ObjectName", "Credit")
            )
            description_years = {
                int(word)
                for word in re.findall(r"\b\d{4}\b", description)
                if 1880 <= int(word) <= 2100
            }
            if year not in description_years:
                continue

        return {
            "url": image_url,
            "source_url": image_info.get("descriptionurl"),
            "license": metadata_value("LicenseShortName"),
            "artist": metadata_value("Artist"),
        }
    return None
