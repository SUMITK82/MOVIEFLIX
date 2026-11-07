(() => {
  const API_BASE = location.origin;
  const PAGE_SIZE = 24;
  const MAX_SEARCH_RESULTS = 15;
  const SHELF_SIZE = 40;
  const form = document.getElementById("form");
  const input = document.getElementById("input");
  const submit = document.getElementById("submit");
  const statusEl = document.getElementById("status");
  const searchSection = document.getElementById("search-section");
  const resultsTitle = document.getElementById("results-title");
  const resultsCount = document.getElementById("results-count");
  const resultsEl = document.getElementById("results");
  const movieShelves = document.getElementById("movie-shelves");
  const catalogGrid = document.getElementById("catalog-grid");
  const catalogQuery = document.getElementById("catalog-query");
  const clearCatalogSearch = document.getElementById("clear-catalog-search");
  const sortMovies = document.getElementById("sort-movies");
  const minimumRating = document.getElementById("minimum-rating");
  const watchlistToggle = document.getElementById("watchlist-toggle");
  const genreTabs = document.getElementById("genre-tabs");
  const surprisePick = document.getElementById("surprise-pick");
  const prevPage = document.getElementById("prev-page");
  const nextPage = document.getElementById("next-page");
  const pageDots = document.getElementById("page-dots");
  const movieDialog = document.getElementById("movie-dialog");
  const movieDialogContent = document.getElementById("movie-dialog-content");
  const tabs = [...document.querySelectorAll(".tab")];
  const startOver = document.getElementById("start-over");
  const recentSearchesSection = document.getElementById("recent-searches");
  const recentSearchList = document.getElementById("recent-search-list");
  const clearRecentSearches = document.getElementById("clear-recent-searches");

  let mode = "search";
  let movies = [];
  let filteredMovies = [];
  let currentPage = 1;
  let selectedGenre = "all";
  let showWatchlist = false;
  let savedMovieIds = new Set();
  let lastSurpriseId = "";
  let similarRequestId = 0;
  let searchRequestId = 0;
  let searchController = null;
  let catalogSearchTimer = null;
  let recentSearches = [];
  let posterObserver;

  try {
    const storedWatchlist = JSON.parse(localStorage.getItem("movieflix-watchlist") || "[]");
    if (Array.isArray(storedWatchlist)) {
      savedMovieIds = new Set(storedWatchlist.filter(id => typeof id === "string"));
    }
    const storedSearches = JSON.parse(localStorage.getItem("movieflix-recent-searches") || "[]");
    if (Array.isArray(storedSearches)) {
      recentSearches = storedSearches
        .filter(item => item && typeof item.query === "string" && ["search", "similar"].includes(item.mode))
        .slice(0, 5);
    }
  } catch {
    setStatus("Saved browser data could not be read. You can still search and browse.", "error");
  }

  const placeholders = {
    search: "A dreamy escape with a little mystery…",
    similar: "Type a movie title from the collection…",
  };
  const buttonLabels = {
    search: 'Find my film <span aria-hidden="true">→</span>',
    similar: 'Find similar <span aria-hidden="true">→</span>',
  };

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, character => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character]);
  }

  function setStatus(message = "", kind = "") {
    statusEl.textContent = message;
    statusEl.className = `status${kind ? ` ${kind}` : ""}`;
  }

  function cancelSearch() {
    searchRequestId += 1;
    if (searchController) {
      searchController.abort();
      searchController = null;
    }
    submit.disabled = false;
    submit.classList.remove("is-loading");
    searchSection.classList.remove("is-refreshing");
  }

  function setMode(nextMode, focus = true) {
    if (nextMode === mode) return;
    cancelSearch();
    mode = nextMode;
    tabs.forEach(tab => {
      const active = tab.dataset.mode === mode;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    input.placeholder = placeholders[mode];
    if (mode === "similar") input.setAttribute("list", "movie-titles");
    else input.removeAttribute("list");
    submit.innerHTML = buttonLabels[mode];
    input.value = "";
    if (focus) input.focus();
    setStatus();
  }

  tabs.forEach(tab => tab.addEventListener("click", () => setMode(tab.dataset.mode)));

  function posterMarkup(movie) {
    const title = escapeHtml(movie.title);
    const genres = Array.isArray(movie.genres) ? movie.genres : [];
    const firstGenre = genres[0] || "FEATURE";
    const glyph = escapeHtml(
      movie.title.split(/\s+/).slice(0, 2).map(word => word[0]).join("").toUpperCase(),
    );
    return `
      <div class="poster-frame">
        <div class="poster-placeholder">
          <span class="poster-glyph">${glyph}</span>
          <span class="poster-placeholder-label">${escapeHtml(genres.slice(0, 2).join(" · ") || firstGenre)}</span>
        </div>
        <img class="poster-image" alt="${title} poster" loading="lazy" />
        <span class="poster-ribbon">${escapeHtml(firstGenre)}</span>
      </div>`;
  }

  function ratingMarkup(movie) {
    if (movie.rating === null || movie.rating === undefined || movie.rating === "") return "";
    const rating = Number(movie.rating);
    if (!Number.isFinite(rating)) return "";
    const label = `<span class="rating-source">IMDb</span><span class="rating-value">${rating.toFixed(1)}<small>/10</small></span>`;
    return movie.imdb_id
      ? `<a class="movie-rating" href="https://www.imdb.com/title/${escapeHtml(movie.imdb_id)}/" target="_blank" rel="noopener noreferrer" aria-label="IMDb rating ${rating.toFixed(1)} out of 10; open IMDb title">${label}</a>`
      : `<div class="movie-rating" aria-label="IMDb rating ${rating.toFixed(1)} out of 10">${label}</div>`;
  }

  function resultCard(movie, index) {
    const pct = (Math.max(0, Math.min(1, Number(movie.match) || 0)) * 100).toFixed(0);
    const year = movie.year ? `<span class="movie-year">${escapeHtml(movie.year)}</span>` : "";
    const genres = Array.isArray(movie.genres) ? movie.genres : [];
    return `
      <article class="result-card poster-card" tabindex="0" aria-haspopup="dialog" aria-label="View details for ${escapeHtml(movie.title)}" data-title="${escapeHtml(movie.title)}" data-imdb-id="${escapeHtml(movie.imdb_id || "")}" data-year="${escapeHtml(movie.year || "")}" style="animation-delay:${Math.min(index * 28, 350)}ms">
        ${posterMarkup(movie)}
        <div class="result-info">
          ${ratingMarkup(movie)}
          <div class="result-title-row"><h3>${escapeHtml(movie.title)}</h3>${year}</div>
          <div class="result-footer">
            <div class="genre-tags">${genres.slice(0, 3).map(genre => `<span>${escapeHtml(genre)}</span>`).join("")}</div>
            <span class="match-score"><span>${pct}</span><small>% fit</small></span>
          </div>
          <a class="poster-credit" hidden target="_blank" rel="noopener noreferrer">Image details</a>
        </div>
      </article>`;
  }

  function catalogCard(movie, index) {
    const year = movie.year ? `<span class="catalog-year">${escapeHtml(movie.year)}</span>` : "";
    const genres = Array.isArray(movie.genres) ? movie.genres : [];
    return `
      <article class="catalog-card poster-card" tabindex="0" aria-haspopup="dialog" aria-label="View details for ${escapeHtml(movie.title)}" data-title="${escapeHtml(movie.title)}" data-imdb-id="${escapeHtml(movie.imdb_id || "")}" data-year="${escapeHtml(movie.year || "")}" style="animation-delay:${Math.min(index * 28, 350)}ms">
        ${posterMarkup(movie)}
        <div class="catalog-card-info">
          ${ratingMarkup(movie)}
          <div class="catalog-card-heading"><h3>${escapeHtml(movie.title)}</h3>${year}</div>
          <p class="catalog-genres">${escapeHtml(genres.slice(0, 3).join(" · ") || "Feature")}</p>
          <a class="poster-credit" hidden target="_blank" rel="noopener noreferrer">Image details</a>
        </div>
      </article>`;
  }

  function movieKey(movie) {
    return movie.imdb_id || movie.title;
  }

  function updateGenreTabs() {
    const genres = [...new Set(movies.flatMap(movie => movie.genres || []))]
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    const options = [["all", "All films"], ...genres.map(genre => [genre, genre])];
    genreTabs.replaceChildren();
    options.forEach(([genre, label]) => {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = `genre-tab${genre === selectedGenre ? " is-active" : ""}`;
      tab.dataset.genre = genre;
      tab.setAttribute("aria-pressed", String(genre === selectedGenre));
      tab.textContent = label;
      genreTabs.append(tab);
    });
  }

  function renderRecentSearches() {
    recentSearchesSection.hidden = recentSearches.length === 0;
    recentSearchList.replaceChildren();
    recentSearches.forEach(item => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "recent-search-chip";
      chip.dataset.mode = item.mode;
      chip.dataset.query = item.query;
      chip.textContent = item.query;
      chip.title = item.mode === "search" ? "Search this mood again" : "Find similar movies again";
      recentSearchList.append(chip);
    });
  }

  function rememberSearch(query, searchMode) {
    recentSearches = [
      { query, mode: searchMode },
      ...recentSearches.filter(item => item.query !== query || item.mode !== searchMode),
    ].slice(0, 5);
    renderRecentSearches();
    try {
      localStorage.setItem("movieflix-recent-searches", JSON.stringify(recentSearches));
      return true;
    } catch {
      return false;
    }
  }

  function updateWatchlistControls() {
    watchlistToggle.classList.toggle("is-active", showWatchlist);
    watchlistToggle.setAttribute("aria-pressed", String(showWatchlist));
    watchlistToggle.querySelector("span").textContent = showWatchlist ? "♥" : "♡";
  }

  function toggleSavedMovie(movie) {
    const key = movieKey(movie);
    const nextSaved = new Set(savedMovieIds);
    const willSave = !nextSaved.has(key);
    if (willSave) nextSaved.add(key);
    else nextSaved.delete(key);
    try {
      localStorage.setItem("movieflix-watchlist", JSON.stringify([...nextSaved]));
    } catch (error) {
      setStatus(`Could not update your watchlist: ${error.message}`, "error");
      return;
    }
    savedMovieIds = nextSaved;
    updateWatchlistControls();
    const saveButton = movieDialogContent.querySelector(".watchlist-save");
    if (saveButton) {
      saveButton.textContent = willSave ? "♥ Saved to watchlist" : "♡ Save to watchlist";
      saveButton.setAttribute("aria-pressed", String(willSave));
    }
    setStatus(willSave ? `${movie.title} saved to your watchlist.` : `${movie.title} removed from your watchlist.`, "success");
    renderCatalog();
  }

  function openMovieDialog(movie) {
    const genres = Array.isArray(movie.genres) ? movie.genres : [];
    const rating = Number(movie.rating);
    const imdbLink = movie.imdb_id
      ? `<a class="dialog-imdb-link" href="https://www.imdb.com/title/${escapeHtml(movie.imdb_id)}/" target="_blank" rel="noopener noreferrer">IMDb ${Number.isFinite(rating) ? rating.toFixed(1) : ""}/10 ↗</a>`
      : "";
    const isSaved = savedMovieIds.has(movieKey(movie));
    movieDialogContent.innerHTML = `
      <button class="dialog-close" type="button" aria-label="Close movie details">×</button>
      <div class="dialog-feature">
        <article class="dialog-poster poster-card" data-title="${escapeHtml(movie.title)}"
          data-imdb-id="${escapeHtml(movie.imdb_id || "")}" data-year="${escapeHtml(movie.year || "")}">
          ${posterMarkup(movie)}
          <a class="poster-credit" hidden target="_blank" rel="noopener noreferrer">Image details</a>
        </article>
        <div class="dialog-overview">
          <p class="section-kicker">MOVIE DETAILS</p>
          <h2 id="dialog-title">${escapeHtml(movie.title)}</h2>
          <p class="dialog-meta">${escapeHtml(movie.year || "Year unknown")}${genres.length ? ` · ${escapeHtml(genres.join(" · "))}` : ""}</p>
          <div class="dialog-footer">${imdbLink}<button class="watchlist-save" type="button" data-imdb-id="${escapeHtml(movie.imdb_id || "")}" aria-pressed="${isSaved}">${isSaved ? "♥ Saved to watchlist" : "♡ Save to watchlist"}</button></div>
        </div>
      </div>
      <section class="dialog-similar" aria-live="polite">
        <div class="dialog-similar-heading"><h3>Similar movies</h3><span class="spinner"></span></div>
        <div class="dialog-similar-list"><p>Finding films with a similar feel…</p></div>
      </section>`;
    if (!movieDialog.open) movieDialog.showModal();
    observePosters(movieDialogContent.querySelector(".dialog-poster"));
    loadSimilarMovies(movie);
  }

  function similarMovieCard(movie, index) {
    const title = escapeHtml(movie.title);
    const glyph = escapeHtml(
      movie.title.split(/\s+/).slice(0, 2).map(word => word[0]).join("").toUpperCase(),
    );
    const genres = Array.isArray(movie.genres) ? movie.genres : [];
    return `
      <article class="similar-poster-card poster-card" data-title="${escapeHtml(movie.title)}"
        data-imdb-id="${escapeHtml(movie.imdb_id || "")}" data-year="${escapeHtml(movie.year || "")}"
        style="animation-delay:${Math.min(index * 35, 350)}ms">
        <button type="button" class="similar-movie" data-imdb-id="${escapeHtml(movie.imdb_id || "")}"
          aria-label="View ${escapeHtml(movie.title)} details">
          <span class="poster-frame">
            <span class="poster-placeholder">
              <span class="poster-glyph">${glyph}</span>
              <span class="poster-placeholder-label">${escapeHtml(genres.slice(0, 2).join(" · ") || "FEATURE")}</span>
            </span>
            <img class="poster-image" alt="${title} poster" loading="lazy" />
            <span class="poster-ribbon">${escapeHtml(genres[0] || "FEATURE")}</span>
          </span>
          <span class="similar-poster-caption">
            <strong>${title}</strong>
            <span>${escapeHtml(genres.slice(0, 3).join(" · ") || "FEATURE")}</span>
          </span>
          <span class="similar-open">Explore film <span aria-hidden="true">↗</span></span>
        </button>
        <a class="poster-credit" hidden target="_blank" rel="noopener noreferrer">Image details</a>
      </article>`;
  }

  async function loadSimilarMovies(movie) {
    const requestId = ++similarRequestId;
    const list = movieDialogContent.querySelector(".dialog-similar-list");
    const spinner = movieDialogContent.querySelector(".dialog-similar-heading .spinner");
    if (spinner) spinner.hidden = false;
    if (list) list.textContent = "Finding films with a similar feel…";
    try {
      const response = await fetch(`${API_BASE}/similar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: movie.title, imdb_id: movie.imdb_id }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      if (!movieDialog.open || requestId !== similarRequestId) return;
      list.innerHTML = data.length
        ? data.map(similarMovieCard).join("")
        : "<p>No similar movies found.</p>";
      observePosters(list);
      movieDialogContent.querySelector(".dialog-similar-heading .spinner")?.remove();
    } catch (error) {
      if (!movieDialog.open || requestId !== similarRequestId) return;
      list.textContent = `Could not load similar movies: ${error.message}`;
      movieDialogContent.querySelector(".dialog-similar-heading .spinner")?.remove();
    }
  }

  [resultsEl, catalogGrid, movieShelves].forEach(container => {
    container.addEventListener("click", event => {
      if (event.target.closest("a, button")) return;
      const card = event.target.closest(".poster-card");
      if (!card) return;
      const movie = movies.find(item => item.imdb_id === card.dataset.imdbId)
        || movies.find(item => item.title === card.dataset.title);
      if (movie) openMovieDialog(movie);
    });
    container.addEventListener("keydown", event => {
      if (!["Enter", " "].includes(event.key) || event.target.closest("a, button")) return;
      const card = event.target.closest(".poster-card");
      if (!card) return;
      event.preventDefault();
      const movie = movies.find(item => item.imdb_id === card.dataset.imdbId)
        || movies.find(item => item.title === card.dataset.title);
      if (movie) openMovieDialog(movie);
    });
  });

  movieDialog.addEventListener("click", event => {
    if (event.target === movieDialog || event.target.closest(".dialog-close")) {
      movieDialog.close();
      return;
    }
    if (event.target.closest(".watchlist-save")) {
      const movie = movies.find(item => item.imdb_id === event.target.closest(".watchlist-save").dataset.imdbId);
      if (movie) toggleSavedMovie(movie);
      return;
    }
    const similarButton = event.target.closest(".similar-movie");
    if (similarButton) {
      const movie = movies.find(item => item.imdb_id === similarButton.dataset.imdbId);
      if (movie) openMovieDialog(movie);
    }
  });
  movieDialog.addEventListener("close", () => {
    similarRequestId += 1;
    movieDialogContent.innerHTML = "";
  });

  async function loadPoster(article) {
    const params = new URLSearchParams({ title: article.dataset.title });
    if (article.dataset.year) params.set("year", article.dataset.year);
    try {
      const response = await fetch(`${API_BASE}/poster?${params}`);
      if (!response.ok) {
        article.classList.add("poster-unavailable");
        return;
      }
      const poster = await response.json();
      const image = article.querySelector(".poster-image");
      const placeholder = article.querySelector(".poster-placeholder");
      image.addEventListener("load", () => {
        placeholder.classList.add("is-hidden");
        article.classList.add("has-poster");
      }, { once: true });
      image.addEventListener("error", () => {
        image.remove();
        article.classList.add("poster-unavailable");
      }, { once: true });
      image.src = poster.url;
      const credit = article.querySelector(".poster-credit");
      if (poster.source_url) {
        credit.href = poster.source_url;
        const attribution = [poster.artist, poster.license].filter(Boolean).join(" · ");
        credit.textContent = attribution || "View image details";
        credit.hidden = false;
      }
    } catch {
      article.classList.add("poster-unavailable");
    }
  }

  function observePosters(container) {
    if (!("IntersectionObserver" in window)) {
      container.querySelectorAll(".poster-card").forEach(article => loadPoster(article));
      return;
    }
    if (!posterObserver) {
      posterObserver = new IntersectionObserver(entries => {
        entries.forEach(entry => {
          if (!entry.isIntersecting) return;
          posterObserver.unobserve(entry.target);
          loadPoster(entry.target);
        });
      }, { rootMargin: "220px 0px" });
    }
    container.querySelectorAll(".poster-card").forEach(article => posterObserver.observe(article));
  }

  function renderResults(matches) {
    const searchMatches = matches.slice(0, MAX_SEARCH_RESULTS);
    searchSection.hidden = false;
    resultsTitle.textContent = mode === "search" ? "Your next watch" : "More like your favorite";
    resultsCount.textContent = "Slide to explore";
    if (!searchMatches.length) {
      resultsEl.innerHTML = '<div class="empty-state"><span>✧</span><h3>No matching stories yet</h3><p>Try a different mood or another title from the collection.</p></div>';
      return;
    }
    resultsEl.innerHTML = searchMatches.map(resultCard).join("");
    observePosters(resultsEl);
    searchSection.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function renderMovieShelves() {
    const rankedByRating = [...movies].sort((a, b) =>
      (b.rating || 0) - (a.rating || 0) || (b.rating_votes || 0) - (a.rating_votes || 0));
    const rankedByVotes = [...movies].sort((a, b) => (b.rating_votes || 0) - (a.rating_votes || 0));
    const superheroPattern = /super[ -]?hero|comic[- ]book|marvel|dc comics|batman|superman|spider[- ]?man|avengers|x[- ]men|wonder woman|deadpool|iron man|black panther|captain america|guardians of the galaxy|aquaman|shazam|venom|joker|hellboy|blade|daredevil|fantastic four|wolverine|the hulk|doctor strange/i;
    const shelves = [
      { title: "Legendary movies", eyebrow: "TIMELESS STORIES", picks: rankedByRating.filter(movie => (Number(movie.rating) || 0) >= 7.5) },
      { title: "Superhero movies", eyebrow: "HEROES & COMIC-BOOK WORLDS", picks: rankedByVotes.filter(movie => superheroPattern.test(`${movie.title} ${movie.description || ""}`)) },
      { title: "Sci-fi movies", eyebrow: "WORLDS BEYOND OURS", picks: rankedByRating.filter(movie => (movie.genres || []).includes("Sci-Fi")) },
      { title: "Fantasy movies", eyebrow: "MAGICAL WORLDS & EPIC ADVENTURES", picks: rankedByRating.filter(movie => (movie.genres || []).includes("Fantasy")) },
    ];
    movieShelves.innerHTML = shelves.map((shelf, index) => {
      const picks = shelf.picks.slice(0, SHELF_SIZE);
      if (!picks.length) return "";
      return `<section class="movie-shelf" aria-labelledby="movie-shelf-title-${index}">
        <div class="shelf-heading"><div><p class="section-kicker">${escapeHtml(shelf.eyebrow)}</p><h3 id="movie-shelf-title-${index}">${escapeHtml(shelf.title)}</h3></div>
          <div class="slider-controls"><button class="slider-button" type="button" data-scroll="prev" aria-label="Scroll ${escapeHtml(shelf.title)} left">←</button><button class="slider-button" type="button" data-scroll="next" aria-label="Scroll ${escapeHtml(shelf.title)} right">→</button></div>
        </div><div class="movie-shelf-track" aria-label="${escapeHtml(shelf.title)}">${picks.map(catalogCard).join("")}</div>
      </section>`;
    }).join("");
    movieShelves.querySelectorAll(".movie-shelf-track").forEach(track => {
      observePosters(track);
    });
  }

  function renderPagination(pageCount) {
    const startPage = Math.max(1, Math.min(currentPage - 3, pageCount - 6));
    const endPage = Math.min(pageCount, startPage + 6);
    pageDots.innerHTML = Array.from({ length: endPage - startPage + 1 }, (_, index) => {
      const page = startPage + index;
      return `<button type="button" class="page-dot${page === currentPage ? " active" : ""}" data-page="${page}" aria-label="Page ${page}" aria-current="${page === currentPage ? "page" : "false"}">${page}</button>`;
    }).join("");
    prevPage.disabled = currentPage <= 1;
    nextPage.disabled = currentPage >= pageCount;
  }

  function renderCatalog() {
    const query = catalogQuery.value.trim().toLocaleLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
    const ratingFloor = Number(minimumRating.value) || 0;
    filteredMovies = movies.filter(movie => {
      const searchableText = [movie.title, movie.year, ...(movie.genres || [])]
        .join(" ")
        .toLocaleLowerCase()
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "");
      const titleMatches = !query || searchableText.includes(query);
      const genreMatches = selectedGenre === "all" || (movie.genres || []).includes(selectedGenre);
      const watchlistMatches = !showWatchlist || savedMovieIds.has(movieKey(movie));
      const ratingMatches = ratingFloor === 0 || (Number(movie.rating) || 0) >= ratingFloor;
      return titleMatches && genreMatches && watchlistMatches && ratingMatches;
    });
    const compareMovies = {
      popular: (a, b) => (b.rating_votes || 0) - (a.rating_votes || 0),
      rating: (a, b) => (b.rating || 0) - (a.rating || 0) || (b.rating_votes || 0) - (a.rating_votes || 0),
      newest: (a, b) => b.year - a.year || (b.rating || 0) - (a.rating || 0),
      oldest: (a, b) => a.year - b.year || (b.rating || 0) - (a.rating || 0),
      title: (a, b) => a.title.localeCompare(b.title),
    };
    filteredMovies.sort(compareMovies[sortMovies.value] || (() => 0));
    const pageCount = Math.max(1, Math.ceil(filteredMovies.length / PAGE_SIZE));
    currentPage = Math.min(currentPage, pageCount);
    const start = (currentPage - 1) * PAGE_SIZE;
    const pageMovies = filteredMovies.slice(start, start + PAGE_SIZE);

    clearCatalogSearch.hidden = !catalogQuery.value;
    if (!pageMovies.length) {
      const emptyTitle = showWatchlist ? "Your watchlist is empty" : "No films found";
      const emptyMessage = showWatchlist
        ? "Open a movie and save it here for later."
        : "Try another title or browse a different genre.";
      catalogGrid.innerHTML = `<div class="empty-state catalog-empty"><span>⌕</span><h3>${emptyTitle}</h3><p>${emptyMessage}</p></div>`;
    } else {
      catalogGrid.innerHTML = pageMovies.map(catalogCard).join("");
      observePosters(catalogGrid);
    }
    surprisePick.disabled = filteredMovies.length === 0;
    renderPagination(pageCount);
  }

  function surpriseMe() {
    if (!filteredMovies.length) {
      setStatus("Nothing to pick from yet. Try another genre or search.", "error");
      return;
    }
    const choices = filteredMovies.length > 1
      ? filteredMovies.filter(movie => movieKey(movie) !== lastSurpriseId)
      : filteredMovies;
    const movie = choices[Math.floor(Math.random() * choices.length)];
    lastSurpriseId = movieKey(movie);
    setStatus(`Tonight’s pick: ${movie.title}`, "success");
    openMovieDialog(movie);
  }

  async function loadCatalog() {
    try {
      const response = await fetch(`${API_BASE}/catalog`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      movies = Array.isArray(data.movies) ? data.movies : [];
      document.getElementById("movie-titles").innerHTML = movies
        .map(movie => `<option value="${escapeHtml(movie.title)}"></option>`)
        .join("");
      updateGenreTabs();
      updateWatchlistControls();
      renderMovieShelves();
      movieShelves.parentElement.hidden = movies.length === 0;
      renderCatalog();
    } catch (error) {
      catalogGrid.innerHTML = `<div class="empty-state catalog-empty"><span>!</span><h3>We couldn’t load the collection</h3><p>${escapeHtml(error.message)}</p></div>`;
      prevPage.disabled = true;
      nextPage.disabled = true;
    }
  }

  form.addEventListener("submit", async event => {
    event.preventDefault();
    const value = input.value.trim();
    if (!value) {
      setStatus("Add a mood or title to start your search.", "error");
      return;
    }
    const path = mode === "search" ? "/search" : "/similar";
    const field = mode === "search" ? "query" : "title";
    const searchMode = mode;
    const requestId = ++searchRequestId;
    searchController = new AbortController();
    submit.disabled = true;
    submit.classList.add("is-loading");
    setStatus(searchMode === "search" ? "Finding the right story…" : "Looking for a close match…", "loading");
    searchSection.classList.add("is-refreshing");

    try {
      const response = await fetch(`${API_BASE}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
        signal: searchController.signal,
      });
      const data = await response.json();
      if (requestId !== searchRequestId) return;
      if (!response.ok) {
        if (response.status === 404 && searchMode === "similar") {
          throw new Error(`“${value}” isn’t in the collection yet. Try one of the titles below.`);
        }
        throw new Error(data.error || `Request failed (HTTP ${response.status}).`);
      }
      mode = searchMode;
      renderResults(Array.isArray(data) ? data : []);
      const saved = rememberSearch(value, searchMode);
      setStatus(
        `Your picks are ready${saved ? "" : " · recent searches could not be saved"}`,
        saved ? "success" : "error",
      );
    } catch (error) {
      if (requestId !== searchRequestId) return;
      searchSection.classList.remove("is-refreshing");
      setStatus(error instanceof TypeError
        ? "Can’t reach MOVIEFLIX right now. Check that the app is running and try again."
        : error.message, "error");
    } finally {
      if (requestId === searchRequestId) {
        searchController = null;
        submit.disabled = false;
        submit.classList.remove("is-loading");
        searchSection.classList.remove("is-refreshing");
      }
    }
  });

  document.querySelectorAll(".prompt-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      setMode("search");
      input.value = chip.dataset.prompt;
      form.requestSubmit();
    });
  });

  startOver.addEventListener("click", () => {
    if (movieDialog.open) movieDialog.close();
    cancelSearch();
    clearTimeout(catalogSearchTimer);
    catalogSearchTimer = null;
    similarRequestId += 1;
    searchSection.hidden = true;
    resultsEl.replaceChildren();
    catalogQuery.value = "";
    input.value = "";
    setStatus();
    setMode("search", false);
    selectedGenre = "all";
    showWatchlist = false;
    sortMovies.value = "popular";
    minimumRating.value = "0";
    updateGenreTabs();
    updateWatchlistControls();
    currentPage = 1;
    renderCatalog();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  catalogQuery.addEventListener("input", () => {
    currentPage = 1;
    clearCatalogSearch.hidden = !catalogQuery.value;
    clearTimeout(catalogSearchTimer);
    catalogSearchTimer = setTimeout(() => {
      catalogSearchTimer = null;
      renderCatalog();
    }, 120);
  });
  clearCatalogSearch.addEventListener("click", () => {
    clearTimeout(catalogSearchTimer);
    catalogSearchTimer = null;
    catalogQuery.value = "";
    currentPage = 1;
    renderCatalog();
    catalogQuery.focus();
  });
  sortMovies.addEventListener("change", () => {
    currentPage = 1;
    renderCatalog();
  });
  minimumRating.addEventListener("change", () => {
    currentPage = 1;
    renderCatalog();
  });
  genreTabs.addEventListener("click", event => {
    const tab = event.target.closest("[data-genre]");
    if (!tab) return;
    selectedGenre = tab.dataset.genre;
    showWatchlist = false;
    updateGenreTabs();
    updateWatchlistControls();
    currentPage = 1;
    renderCatalog();
  });
  surprisePick.addEventListener("click", surpriseMe);
  watchlistToggle.addEventListener("click", () => {
    showWatchlist = !showWatchlist;
    updateWatchlistControls();
    currentPage = 1;
    renderCatalog();
  });
  recentSearchList.addEventListener("click", event => {
    const chip = event.target.closest(".recent-search-chip");
    if (!chip) return;
    setMode(chip.dataset.mode);
    input.value = chip.dataset.query;
    form.requestSubmit();
  });
  clearRecentSearches.addEventListener("click", () => {
    recentSearches = [];
    renderRecentSearches();
    try {
      localStorage.removeItem("movieflix-recent-searches");
    } catch {
      setStatus("Recent searches were cleared for this session but could not be removed from browser storage.", "error");
    }
  });
  function scrollSlider(event, controls) {
    const button = event.target.closest("[data-scroll]");
    if (!button) return;
    const track = controls.parentElement.querySelector(".movie-slider, .movie-shelf-track")
      || controls.closest(".movie-shelf")?.querySelector(".movie-shelf-track");
    if (!track) return;
    const card = track.querySelector(".poster-card");
    const distance = card ? card.getBoundingClientRect().width + 14 : track.clientWidth * 0.8;
    const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    track.scrollBy({ left: button.dataset.scroll === "next" ? distance : -distance, behavior });
  }

  document.querySelectorAll(".slider-controls").forEach(controls => {
    controls.addEventListener("click", event => scrollSlider(event, controls));
  });
  movieShelves.addEventListener("click", event => {
    const controls = event.target.closest(".slider-controls");
    if (controls) scrollSlider(event, controls);
  });
  prevPage.addEventListener("click", () => {
    if (currentPage <= 1) return;
    currentPage -= 1;
    renderCatalog();
    document.getElementById("collection").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  nextPage.addEventListener("click", () => {
    if (currentPage >= Math.ceil(filteredMovies.length / PAGE_SIZE)) return;
    currentPage += 1;
    renderCatalog();
    document.getElementById("collection").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  pageDots.addEventListener("click", event => {
    const button = event.target.closest("[data-page]");
    if (!button) return;
    currentPage = Number(button.dataset.page);
    renderCatalog();
  });

  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && searchController) {
      cancelSearch();
      setStatus("Search cancelled.", "success");
      return;
    }
    if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) return;
    event.preventDefault();
    input.focus();
  });

  renderRecentSearches();
  loadCatalog();
})();
