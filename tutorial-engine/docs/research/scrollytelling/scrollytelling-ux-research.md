# Comprehensive Analysis of Scrollytelling: Interaction Patterns, Architectural Benchmarks, Engineering Pitfalls, and Authoring DSLs

Scrollytelling—the interaction model that synchronizes reader scroll progression with dynamic
visual, graphic, or structural state transitions—has matured from an experimental data-journalism
feature into a mainstream UX design paradigm [1]. By using scrolling as an input mechanism for
progressive disclosure, scrollytelling enables authors to guide users through complex data landscapes,
multi-layered diagrams, and step-by-step code walkthroughs while allowing the user to control narrative
pacing [1]. However, implementing scrollytelling effectively requires balancing cognitive ergonomics,
web animation performance, accessibility compliance, and authoring productivity [5].

## Architectural Patterns of Scrollytelling

Scrollytelling relies on an established vocabulary of design patterns that govern how scrolling text
interacts with accompanying visual elements [6]. Selecting the proper pattern depends on narrative
goals, content structure, visual density, and targeted viewport sizes [1].

### Structural Interaction Patterns

The sticky figure pattern pairs a scrolling narrative text column with a graphic element that remains
fixed ("pinned") in the viewport using CSS `position: sticky` [6]. As individual narrative blocks cross a
specified viewport trigger line, threshold events modify the visual state of the pinned graphic [6]. This
pattern is effective when an author presents sequential annotations or distinct analytical perspectives on
a single subject, such as dissecting a complex financial chart or highlighting geographic regions on a
map [6].

In a scrubbed sequence, user scroll progress maps directly to the continuous playback timeline of an
animation, vector render, canvas draw loop, or video [1]. Rather than triggering step-based visual
updates, the scroll position directly controls frame interpolation [1]. This pattern fits structural
assemblies, spatial transitions, or continuous physical processes where intermediate states between
keyframes carry critical meaning [6].

Step triggers serve as the fundamental control mechanism for step-based scrollytelling [6]. Using
browser observer APIs, text elements act as waypoints that fire enter, exit, and progress events when
crossing a viewport threshold [6]. These triggers drive discrete visual state changes without requiring
frame-by-frame interpolation [6].

Staged reveals present dense, multi-layered visual concepts incrementally [1]. Instead of displaying an
entire visualization at once, individual data series, visual layers, or textual annotations reveal themselves
step-by-step as narrative text scrolls into view [1]. This minimizes cognitive overload and ensures reader
focus aligns with the specific data point under discussion [1].

Parallax scrolling uses multi-layered backgrounds and foregrounds moving at differential scroll speeds to
establish visual depth cues [1]. While useful for atmospheric immersion or introductory scenes, parallax
offers limited analytical utility and introduces elevated CPU/GPU overhead and motion-sickness risks if
applied carelessly [1].

Spatial 3D transitions leverage scroll position to manipulate camera orientation, zoom levels, and object
coordinates within a WebGL rendering context [6]. This pattern is suited for geographical, architectural,
or molecular exploration, though it demands higher graphics processing power and fallback logic for
mobile devices [6].

### Scrollytelling Pattern Comparison

| Pattern | Primary Narrative Purpose | Structural Fit | Technical / Computational Cost | Mobile Layout Strategy | Motion Sensitivity Risk |
| --- | --- | --- | --- | --- | --- |
| Sticky Figure | Annotating or breaking down a single visual subject through sequential narrative claims [6]. | Interactive slideshows, annotated charts, data walkthroughs [6]. | Low (CSS `position: sticky` plus observer threshold triggers) [6]. | Stack graphics above text or unpin graphics into inline visual blocks [6]. | Low [6]. |
| Scrubbed Sequence | Displaying continuous mechanical, temporal, or spatial transformations [1]. | Continuous timelines, frame animations, vector transforms [6]. | Medium to High (requires continuous canvas updates or DOM interpolations) [1]. | Reduce frame interpolation density; convert keyframes to static step images [6]. | Moderate [6]. |
| Step Triggers | Discrete state changes; serves as the underlying engine for stepped stories [6]. | Universal application across editorial and technical walkthroughs [6]. | Low (IntersectionObserver threshold callbacks) [6]. | Maintain trigger logic with scaled mobile threshold offsets [6]. | Very Low [6]. |
| Staged Reveal | Building multi-layered analytical arguments or complex charts progressively [1]. | Data journalism, technical documentation, complex diagrams [1]. | Very Low (toggling element visibility, opacity, or simple SVG groups) [6]. | Render accumulated visual layers inline with narrative steps [6]. | Very Low [6]. |
| Parallax | Establishing atmospheric visual depth and setting context [1]. | Brand microsites, promotional pages, landing scenes [1]. | Low to Medium (GPU-driven multi-layer composite transforms) [1]. | Disable parallax effects entirely on narrow screens [6]. | High (can trigger vestibular discomfort) [6]. |
| 3D / WebGL | Navigating within spatial geometries or geographic terrains [6]. | Architectural models, spatial GIS data, structural molecular views [6]. | High (GPU rendering pipeline, asset loads, custom shaders) [6]. | Fall back to pre-rendered static keyframe images [6]. | High [6]. |

## Benchmark Reference Implementations and Historical Context

The evolution of scrollytelling spans over a decade of digital publishing, illustrating how technical
frameworks and authoring methodologies have matured from bespoke scripts to standardized systems [1].

The early era of web scrollytelling was defined by landmark pieces such as *The New York Times* 2012
feature *Snow Fall: The Avalanche at Tunnel Creek* [2]. *Snow Fall* demonstrated the narrative power
of integrating text with scroll-triggered aerial renders, topographic maps, and video loops [2]. However,
early implementations relied heavily on continuous wheel and scroll event listeners coupled with manual
DOM offset calculations [6]. These approaches caused layout thrashing, frame drops, and rendering
issues across heterogeneous device environments [1].

As web standards evolved, digital publications like The Pudding popularized modern scrollytelling patterns
by separating scroll detection from DOM rendering [12]. By building and open-sourcing utilities such as
Scrollama, The Pudding established the side-by-side sticky figure pattern as an industry standard [7]. In
these implementations, scrolling text columns trigger state transitions in D3-driven SVG data graphics,
demonstrating how observer APIs reduce performance overhead while preserving authorial intent [7].
Commercial microsites, such as Nike's Better World campaign, demonstrated multi-layer parallax
scrolling for promotional narratives, while highlighting the limitations of applying continuous parallax to
reference-heavy core web properties [1].

Recent applications highlight how scrollytelling translates into scientific publishing, spatial analysis, and
public policy communication [2]:

In computational urban research, the Vienna Council Housing and Income Inequality project uses spatial
scrollytelling to guide readers through neighborhood income distributions and public housing allocations
[2]. Maps dynamically update and filter based on narrative scroll position, allowing readers to analyze
structural policy trends [2].

In sports analytics, the EURO 2024 Final Tactical Analysis visualizes match events, spatial passing
networks, and team formations [2]. Scroll-triggered steps synchronize play-by-play commentary with
animated pitch visualizations, providing structured context for tactical breakdowns [2].

In environmental and geospatial research, the OpenSkiStats study uses scrollytelling to explain
methodologies for calculating mountain ski area orientations across global terrains, combining interactive
terrain models with academic copy [2].

## UX Anti-Patterns, Accessibility Engineering, and Performance Optimization

Despite its narrative strengths, scrollytelling is susceptible to severe usability flaws, performance
bottlenecks, and accessibility violations if implemented without proper technical controls [5].

### SCROLLYTELLING ARCHITECTURAL MODES

```text
1. NATIVE OBSERVER MODE (RECOMMENDED)

[ User Input ] ---> ( Passive Scroll ) ---> [ IntersectionObserver ]
                                      |
                             ( State Transition )
                                      |
                          [ CSS position: sticky ]

2. SCROLLJACKING ANTI-PATTERN (AVOID)

[ User Input ] ---> ( Event Interception ) -x- [ Native Scroll ]
                        |
              ( Forced Animation ) ---> [ Layout Thrashing ]
```

### Critical Accessibility Anti-Patterns

Scrolljacking remains the most disruptive scrollytelling anti-pattern [1]. Scrolljacking occurs when a
site intercepts native mousewheel, touch, or trackpad events to override scroll physics, impose fixed
animation durations, or force rigid screen snapping [1]. This violates core browser expectations,
disorients users, causes performance stuttering, and disrupts assistive technology navigation, standard
keyboard controls (such as Spacebar, Page Down, and arrow keys), and custom browser scrolling
configurations [1]. Scroll position should remain a passively observed metric; applications must never
restrict or re-engineer native scroll input mechanics [1].

DOM focus theft presents another common accessibility barrier [6]. Automatically moving DOM focus
(`element.focus()`) to graphical elements or incoming step text as a user scrolls disrupts screen reader
navigation, resets the document caret, and disorients keyboard users [6]. Visual state updates must be
communicated using polite live regions (`aria-live="polite"`) or redundant textual explanations within the
standard document flow, without stealing DOM focus [6].

Improper handling of user motion preferences (`prefers-reduced-motion`) creates significant usability
issues [6]. A common mistake is disabling visual transitions while leaving sticky elements pinned in place,
which results in broken layouts where text scrolls over visually incorrect, static graphics [6]. Under
`prefers-reduced-motion: reduce`, the application should render an alternative structural layout: unpin
sticky figures, convert side-by-side structures into standard vertical flows, display the final static visual
state for each step directly adjacent to its corresponding narrative block, and allow the document to
function as an illustrated static article [6].

Trapping information exclusively within visual layers prevents screen reader users and fast-scrolling
readers from accessing core insights [6]. If key analytical takeaways exist only inside an unannotated
HTML5 canvas, WebGL viewport, or complex SVG graphic, the content is inaccessible [6]. Design patterns
must ensure that every critical datapoint or analytical conclusion is explicitly stated in the scrolling HTML
text layer [6].

### Usability and Architectural Misalignments

Applying scrollytelling to reference-oriented or transactional content creates a fundamental UX mismatch
[3]. Users accessing documentation, API specs, pricing tables, or policy databases require rapid
searchability, scannability, and stable layouts [6]. Forcing linear, scroll-sequenced reveals onto non-linear
reference content increases interaction cost and frustrates users [6].

Unfunded mobile development frequently results in broken small-screen experiences [6]. Complex
multi-column desktop scrollytelling layouts rarely translate directly to mobile viewports [6]. Mobile
browsers also present dynamic viewport challenges, such as address bars expanding and collapsing during
scrolling, which alters dynamic unit measurements (like `vh`) and causes visual jumping or misaligned
trigger offsets [6]. If project resources cannot fund a dedicated mobile layout strategy—such as
converting side-by-side visualizers into vertically stacked sticky headers—scrollytelling should be avoided
[6].

Design layouts that create a "false bottom" can trick users into believing they have reached the end of an
article, causing them to abandon the content prematurely [10]. Large visual gaps or misaligned margins
between narrative blocks can break reading continuity [10]. Authors must provide clear visual affordances,
such as progress trackers or visible off-screen step borders, to signal ongoing narrative content [10].

### Performance Optimization Guidelines

To prevent frame drops and input latency, scrollytelling engines must avoid layout thrashing [1].
Performing DOM geometry reads—such as `getBoundingClientRect()`, `offsetHeight`, or `offsetTop`—inside
scroll event listeners forces the browser to execute synchronous layout recalculations [1]. Web
applications should rely on the IntersectionObserver API to detect element visibility asynchronously, or
batch geometry queries within `requestAnimationFrame` render loops [6].

Furthermore, visual animations and state transitions during scrolling must be restricted to GPU-compositor
properties: `transform` (`translate`, `scale`, `rotate`) and `opacity` [1]. Animating layout-affecting CSS
properties like `top`, `height`, `width`, or `margin` triggers expensive reflow and repaint calculations on
every scrolled frame, leading to visible stutter [1].

## Open-Source JavaScript/TypeScript Libraries and Frameworks

A rich ecosystem of open-source libraries exists for engineering scroll-driven web experiences, spanning
lightweight visibility observers, framework component wrappers, complex animation engines, and native web
standards [7].

Scrollama remains a standard for lightweight, performant scrollytelling in JavaScript [7]. Created by
Russell Samora, Scrollama uses IntersectionObserver to track element position relative to viewport
threshold lines, eliminating the need for legacy scroll event listeners [7]. Scrollama decouples scroll
detection from visual rendering and delegates DOM pinning entirely to CSS (`position: sticky`), maintaining
a compact footprint [7].

Scrolleo, maintained by Zeit Online, is a modern TypeScript-native ESM-only modernization of Scrollama
[11]. Engineered for newsroom publishing environments, Scrolleo incorporates optimized ResizeObserver
handling, refined TypeScript interfaces, and support for element-specific offset overrides via HTML data
attributes [11].

TwoStep, developed by *The Wall Street Journal*, is an architectural library focused on accessibility and
keyboard controls [17]. It includes native keyboard navigation shortcuts out of the box, enforces
non-scrolljacking interaction patterns, and provides fallbacks for static mobile layouts [17].

GSAP ScrollTrigger is an enterprise-grade animation plugin within the GreenSock ecosystem [9]. It
provides comprehensive APIs for complex multi-stage animation sequencing, canvas scrubbing,
programmatic element pinning, and timeline interpolation [9]. While highly flexible, GSAP ScrollTrigger
carries a larger bundle size and requires developer discipline to prevent over-animation and maintain
accessibility standards [9].

ScrollyTeller, maintained by the Institute for Health Metrics and Evaluation (IHME), is an application-level
framework built on top of Scrollama [21]. It transforms structured tabular data files (such as CSV, TSV,
or JSON) directly into multi-section scrollytelling layouts with synchronized narrative panels [21].

Native CSS Scroll-Driven Animations represent a modern W3C specification that connects keyframe
animations directly to scroll timelines without requiring JavaScript execution [8]. Properties such as
`animation-timeline: scroll()` or `animation-timeline: view()` allow browsers to offload animation
scrubbing directly to the compositor thread [8]. While ideal for visual progress indicators, entry reveals,
and simple keyframe scrubbing, complex state management and assistive technology integrations still
require JavaScript event handling [7].

### JS/TS Scrollytelling Library Comparison

| Library / Engine | Technical Architecture | Bundle Size / Dependencies | Primary Target Use Case | Accessibility Support | Framework Ecosystem |
| --- | --- | --- | --- | --- | --- |
| Scrollama | Asynchronous IntersectionObserver threshold callbacks + native CSS `position: sticky` [7]. | ~3 KB / Zero dependencies [7]. | Data journalism, editorial visual essays, step-triggered graphics [7]. | Non-intrusive scroll handling; delegates DOM management [7]. | react-scrollama [18], vue-scrollama [25]. |
| Scrolleo | Modernized TypeScript ESM fork of Scrollama with built-in ResizeObserver [11]. | Very Light / Zero dependencies [11]. | Enterprise TypeScript projects requiring strict typings and modern ESM builds [11]. | Passive observer tracking; granular step offset configuration [11]. | Native JS/TS integration [11]. |
| TwoStep | Observer engine with automated sticky rail management [17]. | Medium / Historical dependencies (jQuery, Waypoints support) [17]. | Editorial storytelling requiring built-in keyboard shortcuts [17]. | Built-in keyboard navigation shortcuts and non-scrolljacking guarantees [17]. | Native JS [17]. |
| GSAP ScrollTrigger | Canvas and DOM timeline interpolation engine [9]. | Heavy (~25+ KB) / Requires core GSAP library [9]. | Cinematic multi-layer web animations, complex canvas scrubbing [9]. | Requires manual accessibility setup and motion handling [9]. | React, Vue, Svelte integrations. |
| CSS Scroll-Driven Animations | Native browser engine execution on GPU compositor threads [8]. | 0 KB (Native Browser Standard) [19]. | Progress indicators, entrance/exit reveals, keyframe scrubbing [1]. | High performance; supports `@media (prefers-reduced-motion)` natively [6]. | Framework-agnostic (Pure CSS) [19]. |

## Declarative Domain-Specific Languages (DSLs) and Markdown Frameworks

Constructing scrollytelling experiences using imperative HTML, CSS, and custom JavaScript callbacks is
maintenance-intensive and prone to regressions [3]. To streamline authoring, domain-specific languages
(DSLs) and declarative Markdown extensions have emerged [3]. These tools decouple narrative copy from
presentation code, allowing technical and non-technical authors to publish scrollytelling documents using
familiar text-based markup [3].

### Closeread (Quarto Scrollytelling Extension)

Closeread is an open-source scrollytelling extension for the Quarto publishing system (sponsored by
Posit) [3]. Built on top of Scrollama v3, Closeread allows researchers, data scientists, and writers to
build interactive scrollytelling documents within Quarto Markdown (`.qmd`) files [3].

Closeread organizes documents using three declarative syntax building blocks [3]: Sections
(`.cr-section`) are fenced divs that mark the boundaries of a scrollytelling layout within a document [3].
Content outside a section renders as a standard document, allowing scrollytelling blocks to be integrated
into broader technical reports [29]. Stickies (`{#cr-id}`) are fenced divs containing visual elements (such
as charts, maps, code blocks, or images) flagged to remain fixed in the viewport while narrative text
scrolls by [3]. Triggers (`@cr-id` or `focus-on="cr-id"`) are inline cross-references attached to narrative
text blocks that activate, pan, zoom, or update specific sticky elements as they scroll into view [3].

```qmd
title: "Geospatial Analysis of Antarctic Penguin Colonies"
format: closeread-html

Standard introduction rendered in normal document flow...

:::{.cr-section}
We analyze spatial distributions of penguin colonies across Antarctic regions. @cr-map

As we isolate specific geographic sectors, bill length correlations emerge clearly.
[@cr-map]{pan-to="-64.8, -63.5" zoom="3"}

Next, we evaluate the computational data pipeline used for sorting observations: @cr-code

First, we load required analytical libraries and penguin observation data.
[@cr-code]{highlight="1-2"}

Then, we filter observations for the target operational year. [@cr-code]{highlight="4-5"}

:::{#cr-map}
:::

:::{#cr-code}{r}
library(dplyr)
library(palmerpenguins)

penguins |> filter(year == 2008) |> group_by(species) |>
  summarize(avg_bill_length = mean(bill_length_mm))
:::
:::
```

Closeread also includes built-in focus effects for zooming into specific image regions, panning maps, or
highlighting code line ranges (`highlight="1-5"`) without requiring custom JavaScript triggers [3].

### Code Hike (MDX Scrollytelling for Code Walkthroughs)

Code Hike, developed by Rodrigo Pombo, is an open-source toolkit built for React and Next.js
environments that bridges Markdown authoring with React UI components [26]. Code Hike transforms
Markdown content into structured AST data properties passed directly to custom React components [26].

Code Hike utilizes two concepts: Fine-grained Markdown and Headless Codeblocks [26]. Instead of parsing
Markdown into fixed HTML structures, Code Hike uses AST directives to decompose content into structured
properties handled by React Server Components [26].

By pairing structural headers (`## !!steps`) with annotated code fences, Code Hike automatically generates
step-by-step scrollycoding walkthroughs [26]. Authors place magic comments inside code blocks—such as
`// !focus(1:3)`, `// !mark`, or `// !diff`—which are parsed at compile time to drive line-by-line focus
and animation steps as the user scrolls [35].

**Code snippet**

````mdx
## !!steps Section One: Establishing Database Pool

We begin by establishing a secure connection pool to the database instance using client credentials.

```js ! index.js
// !focus(1:4)
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
});
```

!!steps Section Two: Executing Transactional Queries

Next, we check out a client connection and execute our multi-step database query within an isolated
transaction block.

```js
// !focus(6:12)
// !mark[10:11]
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
});

const client = await pool.connect();
try {
  await client.query('BEGIN');
  const res = await client.query('SELECT * FROM users WHERE id = $1', [1]);
  await client.query('COMMIT');
} finally {
  client.release();
}
```
````

### Idyll Markup Language

Idyll is an open-source markup language designed for authoring interactive, data-driven web articles
[cite: 4, 38]. Extending Markdown, Idyll introduces a reactive variable state engine coupled with custom
component rendering [cite: 38, 39]. Authors bind scroll triggers directly to reactive variables, allowing
scroll interactions to update state variables and re-render visual components across the document
[cite: 38].

---

## Strategic Recommendations for Online Training Platform Authorship

For an online training platform seeking to offer scrollytelling as a feature for course creators, the
technical challenge lies in balancing author UX simplicity with platform stability, accessibility, and
rendering flexibility [cite: 3, 6, 27]. Providing raw animation timelines or freeform canvas scripts directly
to course authors introduces high technical complexity, causes mobile layout breakages, and creates
accessibility compliance risks [cite: 6, 16].

The optimal architectural strategy is a Declarative Markdown/MDX DSL Pipeline backed by a Pre-Built
Design System Component Engine.

### TRAINING PLATFORM AUTHORING ARCHITECTURE

```text
[ Authoring Layer ] Author writes structured Markdown/MDX content using step tags
                              |
                              v
[ Validation & Build Guardrails ]
  * AST parser validates triggers and step syntax
  * Automated WCAG verification (prefers-reduced-motion, ARIA)
  * Responsive breakpoint layout generator
                              |
                              v
[ Runtime Rendering Engine ]
  * React/TypeScript design system components
  * IntersectionObserver (Scrollama / Scrolleo integration)
  * Native CSS position: sticky layout engine
```

### Architectural Implementation Roadmap

Course authors should write content using standard Markdown syntax extended with declarative step
directives (such as Closeread or Code Hike syntax) [cite: 3, 26, 27, 29]. Decoupling narrative text from
visual rendering logic ensures content remains sanitized, version-controlled, and portable across screen
sizes.

Rather than requiring authors to construct custom layouts from scratch, the platform should provide four
core scrollytelling block types:

- A Code Walkthrough Block (powered by Code Hike) for software engineering and data science courses,
  where scrolling narrative steps highlight, focus, and diff code lines [cite: 26, 27, 34, 35].
- An Annotated Diagram Block (powered by Closeread-style triggers) for medical, hardware, or
  architectural courses, where text triggers zoom, pan, and callout overlays on high-resolution diagrams
  [cite: 3].
- A Data Visualization Block for finance and analytics courses, where text triggers progressive data
  series reveals or state transitions on charts.
- A Multi-Media Step Block that synchronizes text scrolling with step-based image transitions or video
  frame scrubbing.

The platform's compilation pipeline must enforce accessibility and performance controls automatically.
The build step should compile two rendering targets: a primary interactive `position: sticky` layout and a
secondary unpinned vertical layout triggered when `@media (prefers-reduced-motion: reduce)` is active.
The runtime engine should automatically inject `aria-live="polite"` regions into step containers to announce
active step updates to screen reader users without shifting DOM focus. On mobile viewports below 768px,
side-by-side layouts should automatically reflow into top-pinned graphics with scrolling text below,
preventing layout overflow.

Finally, the authoring interface should include a real-time side-by-side preview editor [cite: 37]. As
authors edit Markdown text, the parser validates trigger syntax on the fly (flagging errors such as
non-existent sticky IDs) before publishing, ensuring a smooth authoring experience and reliable student
viewing [cite: 27, 29].

## Works cited

1. Scrolling Designs: 8 Patterns and When to Use Each (2026) | Lovable, <https://lovable.dev/guides/scrolling-designs-patterns-when-to-use>
2. Communicate your research insights with “scrollytelling” via Closeread, <https://library.smu.edu.sg/topics-insights/communicate-your-research-insights-scrollytelling-closeread>
3. Scrollytelling with Closeread: The Super Low-Code Way to Bring, <https://nightingaledvs.com/scrollytelling-with-closeread/>
4. Idyll Studio: A Structured Editor for Authoring Interactive & Data, <https://www.researchgate.net/publication/355265656_Idyll_Studio_A_Structured_Editor_for_Authoring_Interactive_Data-Driven_Articles>
5. Top accessibility anti-patterns - Joel Strohmeier, <https://www.joelstrohmeier.co.uk/blog/accessibility-anti-patterns/>
6. Scrollytelling Design Patterns: A Practitioner's Reference, <https://scrollytelling.ai/scrollytelling-design-patterns/>
7. russellsamora/scrollama: Scrollytelling with IntersectionObserver., <https://github.com/russellsamora/scrollama>
8. Scroll-driven Animations, <https://scroll-driven-animations.style/>
9. Using GSAP/scrollTrigger to recreate a 'sticky' position, <https://gsap.com/community/forums/topic/42318-using-gsapscrolltrigger-to-recreate-a-sticky-position/>
10. Choosing the right scrolling design pattern for better UX, <https://blog.logrocket.com/ux-design/creative-scrolling-patterns-ux/>
11. Scrolleo - A small vanilla JS scrollytelling library - GitHub, <https://github.com/ZeitOnline/scrolleo>
12. What options are there for creating "scrolly-telling" like on this site?, <https://www.reddit.com/r/DataVizRequests/comments/u0frzc/what_options_are_there_for_creating/>
13. Data Visualization and Statistics - FlowingData, <https://flowingdata.com/page/194/?links>
14. How to implement scrollytelling with six different libraries, <https://pudding.cool/process/how-to-implement-scrollytelling/>
15. Scrollytelling demo using scrollama.js and d3.js - GitHub, <https://github.com/edriessen/scrollytelling-scrollama-d3-demo>
16. Web design patterns to avoid for better accessibility - Bright Blue Gum, <https://brightbluegum.com.au/blog/web-design-patterns-to-avoid-for-better-accessibility/>
17. WSJ/two-step: A JavaScript library for best-practice scrollytelling, <https://github.com/WSJ/two-step>
18. squirrelsquirrel78/react-scrollama: Simple scrollytelling with ... - GitHub, <https://github.com/jsonkao/react-scrollama>
19. Scroll-driven animation timelines - CSS - MDN Web Docs, <https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Scroll-driven_animations/Timelines>
20. Scroll-Driven Storytelling: A Developer's Guide (2026) - Scrollytelling, <https://scrollytelling.ai/scroll-driven-storytelling/>
21. GitHub - ihmeuw/ScrollyTeller: A JavaScript library to build, <https://github.com/ihmeuw/ScrollyTeller>
22. Scroll-driven Animations Module Level 1, <https://drafts.csswg.org/scroll-animations-1/>
23. scroll-timeline CSS property - MDN Web Docs, <https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/scroll-timeline>
24. scroll() CSS function - MDN Web Docs, <https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/animation-timeline/scroll>
25. GitHub - vgshenoy/vue-scrollama: Vue 3 component to setup scroll, <https://github.com/vgshenoy/vue-scrollama>
26. Announcing Code Hike 1.0, <https://codehike.org/blog/v1>
27. Getting Started - Code Hike, <https://codehike.org/docs>
28. Guide - Closeread, <https://closeread.dev/guide/>
29. Components of a Closeread Document, <https://closeread.dev/guide/components.html>
30. 3) Minimal Closeread with Text, <https://www.gastonsanchez.com/learn-closeread/modules/03-intro-text.html>
31. First CCUH Quarto Scrolly (test), <https://drexelccuh.quarto.pub/my-first-quarto-scrolly/>
32. code-hike/codehike: Build rich content websites with ... - GitHub, <https://github.com/code-hike/codehike>
33. Build-time Components - Code Hike, <https://codehike.org/blog/build-time-components>
34. Scrollycoding | Code Hike, <https://codehike.org/docs/layouts/scrollycoding>
35. Powerful Code Blocks With Code Hike and MDX - Medium, <https://medium.com/better-programming/powerful-code-blocks-with-code-hike-and-mdx-4cd60049463f>
36. Code Hike in 100 Seconds - DEV Community, <https://dev.to/fabianfrankwerner/code-hike-in-100-seconds-1d9o>
37. MDX Preview - Obsidian Plugin, <https://community.obsidian.md/plugins/mdx-preview>
