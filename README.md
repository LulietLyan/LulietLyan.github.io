<img src="./image/line-neon.gif" width="100%"><br>

<div id="readme-top"></div>

<div id="user-content-toc">
  <ul align="center">
    <summary><h1 style="display: inline-block"><b>Personal Blog: Astro Static Site</b></h1></summary>
    <a href="#quick-start"><strong>Quick Start »</strong></a>
    <br />
    <a href="#deployment">Deployment</a>
    &middot;
    <a href="#project-structure">Structure</a>
    &middot;
    <a href="#contact">Contact</a>
  </ul>
</div>

<p align="center">
  <img src="https://img.shields.io/badge/Astro-6.1.3-ff5d01?style=for-the-badge&logo=astro&logoColor=white" alt="Astro" />
  <img src="https://img.shields.io/badge/Tailwind_CSS-4.2.0-38bdf8?style=for-the-badge&logo=tailwindcss&logoColor=white" alt="Tailwind CSS" />
  <img src="https://img.shields.io/badge/GitHub_Pages-Ready-222222?style=for-the-badge&logo=githubpages&logoColor=white" alt="GitHub Pages ready" />
  <img src="https://img.shields.io/badge/Package_Manager-npm-cb3837?style=for-the-badge&logo=npm&logoColor=white" alt="npm" />
</p>

<p align="center">
  <img src="./image/SYSU.svg" height="50pt" alt="SYSU" />
  <img src="./image/NSCC-GZ.svg" height="50pt" alt="NSCC-GZ" />
</p>

<img src="./image/line-neon.gif" width="100%"><br>

# Table of Contents

- [Project Background](#project-background)
  - [Design Direction](#design-direction)
- [Quick Start](#quick-start)
  - [Install Dependencies](#install-dependencies)
  - [Start Development Server](#start-development-server)
  - [Build for Production](#build-for-production)
- [Deployment](#deployment)
- [Project Structure](#project-structure)
- [Content Editing](#content-editing)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [Contact](#contact)
- [License](#license)

# Project Background

This repository contains a personal blog rebuilt from an Astro career portfolio template. The previous site was replaced with a cleaner writing-focused experience: a hero section, latest writing timeline, featured notes, topic index, contact links, and GitHub Pages deployment workflow.

The site is intentionally lightweight. It uses local JSON data, Astro static generation, Tailwind CSS, and a small set of reusable components.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Design Direction

- Keep the first screen focused on the author and the writing identity.
- Prefer a dark editorial style with subtle motion and readable layouts.
- Avoid unnecessary project scaffolding, repository metadata, and unused template files.
- Keep content easy to edit through JSON files instead of a CMS.
- Deploy automatically with GitHub Actions and GitHub Pages.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

# Quick Start

## Install Dependencies

```bash
npm install
```

## Start Development Server

```bash
npm run dev
```

The local site will be served by Astro. Open the URL printed in the terminal.

## Build for Production

```bash
npm run build
```

The production output is generated in `dist/`.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

# Deployment

GitHub Pages deployment is configured in:

```text
.github/workflows/deploy.yml
```

The workflow follows the referenced `career-portfolio-template-master` deployment style:

- `actions/checkout@v6`
- `withastro/action@v5`
- `actions/deploy-pages@v4`

Deployment runs automatically when changes are pushed to the `main` branch. It can also be triggered manually from the GitHub Actions tab.

Before using GitHub Pages, make sure the repository Pages source is set to **GitHub Actions** in the repository settings.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

# Project Structure

```text
.
├── .github/workflows/deploy.yml
├── image/
├── public/
├── src/
│   ├── assets/
│   ├── components/
│   ├── data/
│   ├── layouts/
│   ├── pages/
│   ├── styles/
│   └── utils/
├── astro.config.mjs
├── package.json
├── package-lock.json
├── README.md
└── tsconfig.json
```

<p align="right">(<a href="#readme-top">back to top</a>)</p>

# Content Editing

Most visible content is controlled by JSON files:

- `src/data/home.json`: author name, hero copy, SEO fields, and social links
- `src/data/writing.json`: latest writing entries
- `src/data/projects.json`: featured note cards
- `src/data/tech.json`: topic index

Main visual and layout files:

- `src/components/home.astro`
- `src/components/writing.astro`
- `src/components/projects.astro`
- `src/components/tech.astro`
- `src/components/contact.astro`
- `src/styles/global.css`

<p align="right">(<a href="#readme-top">back to top</a>)</p>

# Roadmap

- [x] Rebuild the site as a personal blog
- [x] Add GitHub Pages deployment workflow
- [x] Add project README based on the README template
- [ ] Replace placeholder profile content with final personal details
- [ ] Add real article pages or a content collection
- [ ] Add RSS generation if long-form posts are introduced

<p align="right">(<a href="#readme-top">back to top</a>)</p>

# Contributing

This is a personal blog repository. Contributions are not expected by default, but small fixes can follow the normal GitHub flow:

1. Fork the repository.
2. Create a new branch.
3. Make the change.
4. Run `npm run build`.
5. Open a pull request.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

# Contact

- **Maintainer:** LulietLyan
- **Email:** 1078823037@qq.com
- **GitHub:** [LulietLyan](https://github.com/LulietLyan)

<p align="right">(<a href="#readme-top">back to top</a>)</p>

# License

No license file is currently included in this repository. All rights are reserved unless a license is added later.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<img src="./image/line-neon.gif" width="100%"><br>
