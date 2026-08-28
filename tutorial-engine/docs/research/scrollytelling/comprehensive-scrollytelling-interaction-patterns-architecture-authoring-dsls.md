# Scrollytelling: A Research Report on Techniques, Tools, and a Recommendation for an E‑Learning Authoring Feature

## TL;DR
- **Scrollytelling** — narrative content that appears, changes, or animates as the reader scrolls — is a mature, well-documented UX form born from the NYT's 2012 "Snow Fall"; the dominant open-source foundation is **scrollama** (IntersectionObserver-based, ~6k stars) for step triggers, with **GSAP ScrollTrigger** (made 100% free with the v3.13 release on April 30, 2025) for richer scrubbing/pinning, and emerging **native CSS scroll-driven animations** for simple effects.
- For a **non-developer, markdown-first authoring product**, the strongest models are **Idyll** (a markdown-like DSL for interactive articles, but now largely dormant) and **MDX-based "blocks" tools like Code Hike** (actively maintained); the pragmatic recommendation is to define scroll "steps" in a **thin markdown block syntax** that compiles to a **scrollama- or IntersectionObserver-based runtime**, with a **static linear fallback**.
- Because this is **educational** content, accessibility and skimmability must be first-class: **avoid scroll-jacking**, respect **prefers-reduced-motion**, provide a **semantic linear fallback** for screen readers/SEO, and never make a lesson harder to re-read than plain text. Build on existing libraries rather than a bespoke engine.

## Key Findings
1. **Scrollytelling is defined "in the negative":** when the reader scrolls, something other than the normal movement of the document happens (NZZ graphics team). It differs from parallax (decorative depth), scroll-jacking (hijacking native scroll speed), one-page sites, and slide decks.
2. **The canonical pattern** is a "sticky" pinned graphic with text steps scrolling alongside/over it ("steppers"). The peer-reviewed NZZ vocabulary paper analyzed 50 articles and catalogs five techniques: graphic sequences, animated transitions, panning and zooming, scrolling through movies (moviescroller), and showing/auto-playing content (show-and-play).
3. **Library landscape (2026):** scrollama is the standard but dormant; GSAP ScrollTrigger is the actively-maintained powerhouse and is now free; ScrollMagic and Waypoints are legacy/abandoned; native CSS scroll-driven animations are production-viable in Chromium and Safari but not yet in stable Firefox.
4. **Markdown/DSL authoring:** Idyll pioneered markdown-like authoring of interactive articles but is essentially inactive; Code Hike (MDX) is the healthiest markdown-adjacent option; commercial no-code tools (Shorthand, Flourish, ArcGIS StoryMaps) exist but are closed.
5. **The central pitfall** is scroll-jacking and inaccessible motion; the research literature (Kosara's "Scrollytelling Scourge") and W3C guidance both push toward discrete steppers, reduced-motion support, and graceful degradation.
6. **Recommendation:** adopt an IntersectionObserver/scrollama-based step runtime driven by a simple markdown block syntax, with a linear static fallback — do not build a bespoke scroll-event engine.

## Details

### 1. Definition & Core Concepts

**What it is.** The clearest working definition comes from the Neue Zürcher Zeitung (NZZ) graphics team's peer-reviewed paper "Scrolling into the Newsroom" (Information Design Journal, 2022): *"Scrollytelling refers to a storytelling format in which visual and textual elements appear or change as the reader scrolls through an online article,"* and it is "more clearly defined in the negative: when readers scroll, something other than the conventional movement of a document through the viewport happens." Bill Shander, writing in Nightingale (the Data Visualization Society journal), defines it as "a form of interactive storytelling that unfolds as you scroll and includes elements that are activated or triggered by the scrolling."

**Origins.** The term and form are overwhelmingly traced to **"Snow Fall: The Avalanche at Tunnel Creek,"** by John Branch, published by The New York Times on 20 December 2012. It won the 2013 Pulitzer Prize for Feature Writing and a Peabody Award, and newsrooms literally verbed it ("can we snowfall this?"). The finished piece ran roughly 17,000 words and, per designer Jon Lax, "took 11 people 6 months to create," introducing full-screen background video, parallax, and scroll-triggered multimedia to a mass audience. Academic literature (Dowling and Vogan, 2014) calls it "a watershed moment for journalism." Bloomberg's "What Is Code" (Paul Ford, 2015) and Jim Vallandingham's OpenVisConf 2015 talk "So You Want to Build a Scroller" both mark the point where scrollytelling became a widely-practiced technique.

**How it differs from related techniques:**
- **Parallax scrolling:** background/foreground layers move at different speeds to create depth. It's a *visual effect*, not a narrative mechanism; scrollytelling may *use* parallax but is defined by content change tied to narrative.
- **Scroll-jacking:** the page overrides the browser's native scroll speed/behavior (e.g., one wheel-flick jumps a whole section). It is, per Shander in Nightingale, "when scrolling causes unexpected behavior and is a widely accepted UX faux pas" — distinct from, though often conflated with, scrollytelling.
- **One-page sites:** a layout choice (all content on a single scrolling page); no narrative-scroll coupling required.
- **Slide decks / steppers:** discrete states advanced by clicks/taps/buttons. A "stepper" is the click-driven cousin of scrollytelling; Kosara and others argue steppers are often *better* because navigation is explicit and doesn't fight the reader.

**Core UX patterns:**
- **Sticky/pinned graphic with scrolling text ("steppers" / side-by-side or overlay):** the most common pattern. A graphic is pinned (via CSS `position: sticky` in modern implementations) while text "steps" scroll past; each step triggers a new state of the graphic. Scrollama's canonical examples are "Sticky Graphic (Side by Side)" and "(Overlay)."
- **Scroll-triggered reveal:** an element animates in when it crosses a viewport threshold (enter/exit events).
- **Scrubbing:** scroll position drives an animation/video/chart timeline *directly and proportionally* (GSAP ScrollTrigger's `scrub: true`; the NZZ "moviescroller" where scroll scrubs a video frame-by-frame).
- **Progress within a step:** granular 0–100% callbacks (scrollama's "Step progress").
- **Native scroll vs scroll-jacking:** best practice is to preserve native scroll and only *trigger* changes, not to hijack scroll speed.
- **Progressive disclosure / chapter structure:** content is chunked into sections/chapters with clear orientation cues.
- **Data-viz morphing between states:** a chart transitions between encodings as steps advance (NZZ "animated transitions").
- **Map-based scrollytelling:** scroll drives camera/zoom/pan (NZZ "pan-and-zoom"; Mapbox and ArcGIS patterns).
- **Horizontal scroll sections, sound/video sync, annotation callouts:** supporting patterns.

**Information architecture.** Practitioner guides converge on a narrative arc: an **intro/hook**, **chapters/steps** that build, a **climax/reveal**, a **conclusion**, and an **exit/CTA**. The NZZ paper's "scrolly-atom" model decomposes each scroller into text block ↔ graphic-state relationships (usually one text block per graphic state).

### 2. Classic and Notable Examples / References

- **NYT "Snow Fall" (2012)** — the genre-namer; still live at nytimes.com/projects/2012/snow-fall/. Pulitzer + Peabody.
- **The Guardian "Firestorm" (2013), NYT "A Game of Shark and Minnow," "The Russia Left Behind," SBS "The Boat"** — early landmark long-form scrollers.
- **Bloomberg "What Is Code" (Paul Ford, 2015)** — provoked debate over scrollytelling overuse.
- **The Pudding (pudding.cool)** — a digital publication of visual essays founded in 2017; the single most influential source of scrollytelling craft and open-source tooling (scrollama, svelte-starter). Notable pieces include "Women in Headlines" (2022) and "The Making of a Lenna" (2021).
- **ProPublica "Hawaii's Beaches Are Disappearing"** — cited by the NZZ paper as combining graphic sequences, pan-and-zoom, and show-and-play.
- **National Geographic, Reuters Graphics, FiveThirtyEight, The Upshot** — routine practitioners.

**Design/technical write-ups & retrospectives:**
- **Jim Vallandingham, "So You Want to Build A Scroller"** (vallandingham.me/scroller.html, 2015) and his "Steps for Building a Stepper Visualization" — foundational tutorials.
- **The Pudding, "How to implement scrollytelling with six different libraries"** and **"An Introduction to Scrollama.js"** (pudding.cool/process/) — the canonical build guides, plus a responsive-scrollytelling follow-up and a "position: sticky" guide.
- **Mike Bostock, "How to Scroll"** (bost.ocks.org/mike/scroll/, 2014) — early best-practice reference.
- **Bill Shander, "The Past, Present, and Future of Scrollytelling"** (Nightingale / Data Visualization Society) — the best narrative history.
- **Robert Kosara, "The Scrollytelling Scourge"** (eagereyes.org, 2016) — the definitive critique (see Pitfalls).
- **ONS Digital blog, "How we build scrollytelling articles"** (2021) — a public-sector engineering retrospective (Svelte + Layer Cake + Mapbox GL).

**Academic / industry catalogs of patterns:**
- **Oesch, Roth & Renner, "Scrolling into the Newsroom: A Vocabulary for Scrollytelling Techniques in Visual Online Articles"** (Information Design Journal, 2022) — analyzed 50 articles and defined the five standard techniques. Mirrored in the EU's Data Visualisation Guide (data.europa.eu).
- **Conlen & Heer, "Idyll: A Markup Language for Authoring and Publishing Interactive Articles on the Web"** (ACM UIST 2018; DOI 10.1145/3242587.3242600) — the key academic reference on markdown-like authoring.
- **Seyser & Zeiller, "Scrollytelling – An Analysis of Visual Storytelling in Online Journalism"** (IEEE IV 2018; DOI 10.1109/iV.2018.00075).
- **Mörth et al., "ScrollyVis: Interactive Visual Authoring of Guided Dynamic Narratives for Scientific Scrollytelling"** (IEEE TVCG 2022).
- **Conlen et al., "Fidyll: A Compiler for Cross-Format Data Stories"** (arXiv 2205.09858) — Idyll's cross-format successor concept.

### 3. Pitfalls / Things to Avoid

**UX mistakes:**
- **Scroll-jacking → motion sickness/disorientation.** Kosara's "Scrollytelling Scourge" (posted May 25, 2016) is the definitive critique: "Scroll down and the story unfolds! Except it's often awkward, brittle, and gets in the way." Even years later, Kosara told Nightingale that for stories told in discrete steps "the interaction should be discrete" (tap/swipe per step) — favoring steppers.
- **Accessibility failures:** screen-reader users, keyboard-only users, and users with **vestibular disorders** are routinely excluded. Per Agrawal et al. (2009), "Disorders of Balance and Vestibular Function in US Adults" (NHANES 2001–2004, n=5,086, *Archives of Internal Medicine*), "the prevalence of vestibular dysfunction in the US population aged 40 years and older from 2001-2004 was 35.4%" — roughly 69 million Americans — and parallax/scaling/panning are known triggers. WCAG 2.1 effectively requires honoring **prefers-reduced-motion**.
- **Performance/jank:** heavy scrollytelling tanks Largest Contentful Paint, frustrates low-end mobile, and can damage SEO. Scroll-event listeners cause layout thrashing; IntersectionObserver is the performant alternative.
- **Mobile differences:** narrow viewports, "design for the thumb," sticky behavior and vh units differ; side-by-side layouts must collapse.
- **Over-long narratives / tunneling:** forcing readers through a long guided story to reach other content ("locking users into a tunnel") drives abandonment.
- **Broken back button / deep-linking and SEO/indexing:** when content is injected via JS and state isn't reflected in the URL, browser history and crawlers break.
- **Fighting the reader's scroll pace** and unclear progress/orientation cues.

**Best practices:**
- **Accessibility:** respect `prefers-reduced-motion` (serve a reduced/no-motion experience); provide semantic, linear fallback content that makes sense without animation; use ARIA live regions for dynamic changes; ensure logical tab order and keyboard operability; provide text alternatives/summaries of visual narratives; a "skip"/static-version affordance. The Pudding's own svelte-starter ships a `MotionToggle` component and `.sr-only` utilities.
- **Performance:** prefer **IntersectionObserver** over scroll-event listeners (scrollama's core rationale); lazy-load and right-size media; animate only `transform`/`opacity`; target 60fps; consider off-main-thread native CSS scroll-driven animations where supported; progressive enhancement so core content works without JS.

### 4. Open-Source JS/TS Libraries and Tools (verified ~August 2026)

- **scrollama** (russellsamora/scrollama) — the de facto standard vanilla-JS library by Russell Goldenberg / The Pudding, described in its README as "a modern & lightweight JavaScript library for scrollytelling using IntersectionObserver in favor of scroll events." Provides step triggers, step progress, and the sticky-graphic pattern; no jQuery/D3 dependency. **~6.0k stars, current version 3.2.0**, but **no new release in ~4 years** — stable yet dormant. MIT. Still the most-used foundation.
- **GSAP ScrollTrigger** (greensock/GSAP) — the most powerful scroll-animation toolkit: pinning, scrubbing (`scrub: true`), snapping, velocity, and integration with GSAP timelines and ScrollSmoother. **Scroll-linked animation** approach. **~28k stars, actively maintained (updated April 2026).** Webflow acquired GreenSock in October 2024, and **GSAP became 100% free with the v3.13 release on April 30, 2025**; per GSAP's blog, "the entire GSAP toolset is FREE, even for commercial use," including all bonus plugins (SplitText, MorphSVG, ScrollSmoother, etc.). Note this is GreenSock's standard no-charge license, not literally MIT. Best choice for complex/cinematic effects.
- **ScrollMagic** (janpaepke/ScrollMagic) — older jQuery-era scroll-interaction library, ~15k stars, but **effectively dormant/legacy**; its own README now steers users to GSAP ScrollTrigger, native CSS, or Motion. Avoid for new work.
- **Waypoints** (imakewebthings/waypoints) — jQuery-era trigger library, ~10k stars, **abandoned** (no meaningful activity in ~10 years). Not recommended.
- **react-scrollama** (jsonkao/react-scrollama) — React wrapper adapted from scrollama, IntersectionObserver-based. **~300 stars, lightly maintained** (a release within the past year, v2.4.x). Good for React apps.
- **@sveltejs/svelte-scroller** — official-ish Svelte component (~370 stars) but **dormant** (last npm publish ~5 years ago). Overlays narrative and viz layers.
- **LeaVerou/svelte-scrolly** — a simpler Svelte `<Scrolly>` component (sticky viz + scrolling story) created for MIT's Interactive Visualization & Society course 2024; good teaching reference.
- **the-pudding/svelte-starter** — SvelteKit starter with a `Scrolly.svelte` component, `MotionToggle`, accessible inputs, ArchieML micro-CMS (Google Docs/Sheets), SSR static builds. **~440 stars, actively maintained (2025–2026).** The best modern "batteries-included" starting point.
- **ihmeuw/ScrollyTeller, rdmurphy/scroller, stitchfix/hello-scrollytelling, wsj/two-step, vue-scrollama** — additional community implementations.
- **Native Intersection Observer custom implementations** — the browser API is **Baseline / universally supported**; scrollama, react-scrollama, and svelte-scroller are thin wrappers over it.
- **CSS scroll-driven animations** (`animation-timeline: scroll()` / `view()`) — declarative, off-main-thread, no JS. **Chrome/Edge since 115 (July 2023); Safari since 26 (Sept 2025); NOT enabled by default in stable Firefox as of mid-2026** (behind a flag; an Interop 2026 priority). ~82–84% global support. Use as progressive enhancement with `@supports` and the flackr/scroll-timeline polyfill.

### 5. Markdown-/DSL-Based Scrollytelling Authoring Tools (High Priority)

**Idyll** (idyll-lang/idyll) — the most important reference for a markdown-first model. It is *"a markup language and toolkit for writing interactive articles"* that "starts with the same principles as markdown, and uses a lot of the same syntax," compiling a `.idl` file to an HTML/JS/CSS bundle. Its reactive document model lets non-programmers write prose and drop in components (`[Range][/Range]`, `[Chart/]`, scroll triggers via `onEnterView`/`onExitView`), while developers author custom React/D3 components. It has a scroll example ("Scrolly Idyll"). Academic pedigree: Conlen & Heer, UIST 2018. **However, Idyll is essentially inactive**: ~2k stars, the latest npm is a `6.0.0-alpha` published ~3 years ago, and the main repo's last substantive activity was ~Feb 2023 (Snyk flags it "Inactive"). It is the best *design model* to emulate but not a safe dependency in 2026.

**MDX-based tools:**
- **Code Hike** (code-hike/codehike) — built on **MDX**, actively maintained (v1.0.7, ~May 2026; ~5.3k stars) by Rodrigo Pombo. Its "blocks" concept lets authors structure Markdown with `!`-decorated headings/images/code that become typed objects consumed by layout components; **"scrollycoding"** is a first-class scroll-driven walkthrough. Primarily code-walkthrough oriented and **React-only**, but the *authoring model* (structured markdown → components) is exactly right for a course product.
- **gatsby-theme-waves** (pomber/gatsby-waves) — "Bring scrollytelling to your MDX"; a `<CodeWave>` wraps alternating code/markdown blocks. **Abandoned/superseded by Code Hike** (npm last published ~6 years ago). Its README explicitly names Code Hike as the "spiritual successor."
- **Astro + MDX + D3 patterns** — community architectures separate narrative (MDX with section triggers) from data (TypeScript config) with an Astro layout orchestrating a scrollama-style runtime; a good template for a modern SSG-based approach.

**Static-site-generator options:** Gatsby (waves), Astro (MDX frontmatter defining steps + hydrated islands), Next.js (Code Hike), Eleventy/Hugo (would need a scrollama shortcode/partial). Frontmatter-defined steps tied to media is a natural pattern.

**Newsroom / commercial (mostly closed):**
- **Shorthand** (shorthand.com) — commercial, closed; the tool BBC/NYT/Washington Post-type newsrooms use; very easy WYSIWYG scrollytelling, free tier limited to a few published stories. Excellent for non-developers; not open source, not embeddable into your own runtime.
- **Flourish** (flourish.studio) — commercial (Canva-owned); a "Scrolly" story mode ("no code required") available only to **Publisher/Enterprise** tiers; a low-code scrollytelling library for Enterprise. Closed.
- **ArcGIS StoryMaps** (Esri) — commercial; map-centric scrollytelling; closed.
- **Knight Lab StoryMapJS** (storymap.knightlab.com) — **free and open source** (Northwestern); slide-per-location map storytelling with a friendly Google-auth authoring tool; limited to its map/slide model (recommended ≤20 slides).
- **Odyssey.js** (CartoDB/Carto) — open source but **effectively defunct**; markdown-driven map narratives; historically important as a markdown-DSL map-scrolly tool.
- **Datawrapper** — charts, not scrollytelling per se.
- **Pageflow, Exhibit.so** — additional platforms.

**Non-developer authoring assessment:** Shorthand and Flourish score highest for pure non-coders but are closed/hosted. Idyll and Code Hike are the best *open* markdown-adjacent models, but Idyll is dormant and Code Hike is code-walkthrough-oriented and React-only. **No actively-maintained open-source tool today gives non-developers a clean markdown DSL for general scrollytelling** — which is precisely the gap a course product would fill with a thin custom syntax over scrollama.

### 6. Recommendation for an Online Training/Education Product

**Bottom line:** Build a **thin, opinionated markdown-block authoring syntax** that compiles to an **IntersectionObserver/scrollama-based step runtime**, always rendering a **semantic, linear, static fallback** first (progressive enhancement). Do **not** build a bespoke scroll-event engine, and do **not** adopt scroll-jacking. Reserve heavier scroll-linked animation (GSAP ScrollTrigger) for optional advanced media.

**Best technical foundation.**
- **Primary runtime: scrollama** (or a small in-house IntersectionObserver wrapper modeled on it) for step triggers. Rationale: IntersectionObserver is performant (no scroll-event jank), Baseline-supported, and the sticky-graphic stepper is exactly the pattern lessons need. Caveat: scrollama is dormant, so either vendor it (MIT) or wrap the native API directly (~100 lines) to avoid dependency risk.
- **Optional enhancement layer: GSAP ScrollTrigger** (now free) for lessons that genuinely need scrubbing/pinning/timeline sync — gated behind an "advanced media" block so most authors never touch it.
- **Consider native CSS scroll-driven animations** for lightweight reveals as progressive enhancement (guarded by `@supports`), since they run off the main thread — but keep IntersectionObserver as the baseline because Firefox stable lacks default support as of 2026.

**Authoring experience (markdown-first).** Model the DSL on **Idyll's "prose + components"** ethos and **Code Hike's "decorated blocks"** mechanics, but keep it tiny. For example, in the existing markdown editor:

```
:::scrolly
::step{media="chart-1.svg" alt="Bar chart, 2010 baseline"}
In 2010, enrollment was flat...
::
::step{media="chart-2.svg" alt="Bars rising through 2015"}
By 2015, it had doubled...
::
:::
```

- Each `::step` is one text block bound to one graphic state (the NZZ one-to-one model). Media can be an image, a video (with `show-and-play` semantics), a chart id, or a map camera state.
- Frontmatter defines the sticky layout mode (`side-by-side` | `overlay`), reduced-motion behavior, and whether a static fallback caption is shown.
- Offer a **WYSIWYG step editor** on top that emits this same markdown, so both non-developers (visual) and power users (raw markdown) share one source format.
- Authors provide `alt` text per step (required by the schema) — this doubles as the screen-reader/linear fallback content.

**Suggested architecture:**
1. **Compile** the markdown block to a step list at build time (SSG-friendly: Astro/Next/Eleventy).
2. **Server-render a linear, semantic version first**: each step as a `<section>` with its heading, prose, and the media inline with `alt`/captions — fully readable, skimmable, indexable, and printable *without JS*.
3. **Hydrate progressively**: if JS is on and `prefers-reduced-motion` is not set, an IntersectionObserver upgrades the linear layout into the sticky-graphic stepper.
4. **Respect `prefers-reduced-motion`**: skip pinning/animation, show the linear version (or cross-fade only), and expose a user-facing motion toggle (as The Pudding's `MotionToggle` does).
5. **Accessibility layer**: ARIA live region announcing step changes, logical tab order, keyboard step navigation, `.sr-only` step summaries.
6. **URL/state**: reflect chapter/step in the URL hash for deep-linking and working back button.

**UX patterns worth adopting** (from the canon): the **sticky side-by-side stepper** (clearest for explanation); **one text block ↔ one graphic state**; **clear progress/orientation cues** (Snow Fall's chapter nav and scrollbar-as-length-cue); **discrete-feeling steps** (Kosara's point) rather than continuous scrubbing for conceptual content; **show-and-play** for short demo clips.

**Pitfalls to specifically avoid in a learning context:**
- **No scroll-jacking** — lessons are long-form; hijacking scroll speed fights re-reading and note-taking and causes motion sickness.
- **Never make content harder to skim/re-read than plain text** — the linear fallback must be a first-class reading mode, and learners should be able to jump between steps.
- **Full accessibility compliance** — educational products face legal/ethical accessibility obligations (WCAG/Section 508/EN 301 549); screen-reader and keyboard-only paths are mandatory, not optional.
- **Avoid motion for its own sake** — reserve animation for when it shows change over time or enables comparison (Sleight/ProPublica's test).
- **Performance on low-end devices** — cap media weight; IntersectionObserver not scroll listeners; lazy-load.

**Build vs. adopt — pros/cons:**

| Option | Pros | Cons |
|---|---|---|
| **Adopt scrollama (wrap it)** | Proven, IntersectionObserver-based, tiny, MIT, exact stepper pattern | Dormant (~4 yrs no release); you own maintenance risk |
| **Wrap native IntersectionObserver yourself** | Zero dependency, ~100 lines, full control, Baseline support | You maintain edge cases (resize, sticky quirks) scrollama already solved |
| **Adopt GSAP ScrollTrigger** | Actively maintained, free now, most powerful (scrub/pin) | Heavier; encourages motion-heavy patterns risky for a11y/education; overkill for most lessons |
| **Adopt Idyll** | Real markdown DSL, reactive, academic pedigree | Essentially unmaintained; alpha-only latest; dependency risk |
| **Adopt Code Hike (MDX)** | Actively maintained, great "decorated blocks" authoring model | React-only; code-walkthrough oriented; MDX may be heavier than your editor supports |
| **License Shorthand/Flourish** | Best non-developer UX, zero build | Closed/hosted, recurring cost, can't embed into your runtime/LMS, data control concerns |

**Recommended path:** ship a **custom markdown block DSL (`:::scrolly` / `::step`) → IntersectionObserver stepper runtime (scrollama-wrapped or vendored) → SSR linear fallback**, borrowing Idyll's authoring philosophy and Code Hike's block mechanics, with GSAP ScrollTrigger and native CSS scroll-timeline as optional enhancement layers. This maximizes non-developer authorability while guaranteeing the accessibility, skimmability, and performance a learning product requires.

## Recommendations
1. **Prototype now with scrollama's sticky side-by-side example** and a 3–4 step lesson to validate the pattern with real course authors. *Benchmark to proceed:* authors can create a working scrolly section from markdown in <15 minutes without help.
2. **Define the minimal `:::scrolly`/`::step` markdown schema** with required `alt`/summary fields; build the SSR linear renderer first, the stepper second. *Threshold:* the linear version must pass an automated axe/WCAG scan and be fully navigable by keyboard and screen reader before any animation ships.
3. **Default to reduced motion and native scroll**; add a motion toggle. *Threshold:* Lighthouse performance ≥90 on mid-range mobile and 60fps scroll before release.
4. **Vendor scrollama (MIT) or wrap IntersectionObserver directly** to remove dependency-abandonment risk; keep GSAP ScrollTrigger behind an optional "advanced media" block. *Trigger to add GSAP:* only when authors demonstrably need scrubbing/pinning that IntersectionObserver can't express.
5. **Pilot with a subset of instructors**, measure re-read/skim behavior and completion, and A/B against plain-text lessons. *Change condition:* if scrolly lessons show worse comprehension or completion than plain text, restrict the feature to genuinely visual/temporal content.
6. **Revisit native CSS scroll-driven animations in ~12 months**; once Firefox stable ships them by default, migrate simple reveals off JS for performance.

## Caveats
- **Maintenance data is a moving target.** Star counts are GitHub's rounded figures and release dates were verified around August 2026; treat them as approximate. scrollama's ~4-year release gap means "stable" not "dead," but it is a real risk for a production dependency.
- **GSAP is "free," not strictly MIT.** It uses GreenSock's standard no-charge license under Webflow ownership (free for commercial use as of v3.13, April 30, 2025); verify the current license terms before shipping commercially.
- **Firefox support for native CSS scroll-driven animations** was still behind a flag in stable as of mid-2026; do not rely on it as a baseline yet.
- **Some cited sources are vendor/marketing blogs or SEO content** (e.g., scrollytelling.ai, ui-deploy.com, metabole.studio); their qualitative claims (engagement lifts such as "400% longer time-on-page") are marketing figures, not peer-reviewed, and should not be treated as established fact. The peer-reviewed anchors are the NZZ/IDJ paper, the Idyll UIST paper, and the IEEE/ACM references.
- **The "no good open markdown scrollytelling tool exists" conclusion** reflects the state of actively-maintained OSS in 2026; new tools appear frequently, so re-scan the GitHub `scrollytelling` topic before committing.