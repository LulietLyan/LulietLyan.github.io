<img src="./image/line-neon.gif" width="100%"><br>

<div id="readme-top"></div>

<div id="user-content-toc">
  <ul align="center">
    <summary><h1 style="display: inline-block"><b>Lyan's Notes</b></h1></summary>
    <a href="#quick-start"><strong>Quick Start »</strong></a>
    <br />
    <a href="#topics">Topics</a>
    &middot;
    <a href="#writing">Writing</a>
    &middot;
    <a href="#contact">Contact</a>
  </ul>
</div>

<p align="center">
  <img src="https://img.shields.io/badge/Computer_Network-Ready-4D5F47?style=for-the-badge" alt="Computer Network" />
  <img src="https://img.shields.io/badge/Operating_System-Ready-4D5F47?style=for-the-badge" alt="Operating System" />
  <img src="https://img.shields.io/badge/MySQL-Ready-4D5F47?style=for-the-badge" alt="MySQL" />
  <img src="https://img.shields.io/badge/Redis-Ready-4D5F47?style=for-the-badge" alt="Redis" />
  <img src="https://img.shields.io/badge/Message_Queue-Ready-4D5F47?style=for-the-badge" alt="Message Queue" />
  <img src="https://img.shields.io/badge/Golang-Ready-4D5F47?style=for-the-badge" alt="Golang" />
  <img src="https://img.shields.io/badge/Projects-Standby-222222?style=for-the-badge" alt="Projects" />
</p>

<p align="center">
  <img src="./image/SYSU.svg" height="50pt" alt="SYSU" />
  <img src="./image/NSCC-GZ.svg" height="50pt" alt="NSCC-GZ" />
</p>

<img src="./image/line-neon.gif" width="100%"><br>

# Table of Contents

- [Project Background](#project-background)
- [Topics](#topics)
- [Quick Start](#quick-start)
  - [Install Dependencies](#install-dependencies)
  - [Start Development Server](#start-development-server)
  - [Build for Production](#build-for-production)
- [Writing](#writing)
- [Deployment](#deployment)
- [Project Structure](#project-structure)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [Contact](#contact)
- [License](#license)

# Project Background

This is **Lyan**'s public notebook.

The site collects notes on systems and software: computer networks, operating systems, MySQL, Redis, message queues, Golang, and later project write-ups. The homepage is a short introduction; the real archive lives under topic columns that can nest as deep as needed.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

# Topics

| Column | What it is for |
| --- | --- |
| [Computer Network](./topics/computer-network/README.md) | Links, routing, HTTP, TLS |
| [Operating System](./topics/operating-system/README.md) | Processes, memory, files, concurrency |
| [MySQL](./topics/mysql/README.md) | Storage, indexes, transactions, SQL |
| [Redis](./topics/redis/README.md) | Data structures, persistence, cache |
| [Message Queue](./topics/message-queue/README.md) | Async, peaks, delivery semantics |
| [Golang](./topics/golang/README.md) | Language, concurrency, engineering |
| [Projects](./topics/projects/README.md) | Reserved for project notes and nested sub-columns |

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

Open the URL printed in the terminal to preview the blog locally.

## Build for Production

```bash
npm run build
```

The production output is generated in `dist/`.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

# Writing

All posts live in `topics/`. Edit Markdown locally, then commit.

- A folder is a column.
- That folder's `README.md` is the column homepage.
- Other `.md` files in the folder are articles.
- Nested folders are nested columns. There is no depth limit.

Example:

```text
topics/projects/README.md
topics/projects/foo/README.md
topics/projects/foo/bar/README.md
topics/projects/foo/bar/note.md
```

Optional frontmatter:

```yaml
---
title: Computer Network
description: A short summary for cards and RSS.
icon: mdi:lan
order: 1
date: 2026-08-18
draft: false
tags:
  - Network
---
```

<p align="right">(<a href="#readme-top">back to top</a>)</p>

# Deployment

Push to `main`. GitHub Actions publishes the site to GitHub Pages.

The Pages source should be set to **GitHub Actions** in the repository settings.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

# Project Structure

```text
.
├── .github/workflows/deploy.yml
├── image/
├── public/
├── src/
├── topics/
│   ├── computer-network/README.md
│   ├── operating-system/README.md
│   ├── mysql/README.md
│   ├── redis/README.md
│   ├── message-queue/README.md
│   ├── golang/README.md
│   └── projects/README.md
├── package.json
└── README.md
```

<p align="right">(<a href="#readme-top">back to top</a>)</p>

# Roadmap

- [x] Put Lyan on the homepage
- [x] Open the seven topic columns
- [x] Allow unlimited nested sub-columns
- [x] Write locally through `topics/**/README.md`
- [ ] Fill each column with real notes
- [ ] Add project sub-columns when a project is worth documenting

<p align="right">(<a href="#readme-top">back to top</a>)</p>

# Contributing

This is a personal notebook. The only author is **LulietLyan**. External pull requests are not expected.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

# Contact

- **Author:** Lyan / LulietLyan
- **Email:** 1078823037@qq.com
- **GitHub:** [LulietLyan](https://github.com/LulietLyan)
- **Site:** [lulietlyan.github.io](https://lulietlyan.github.io)

<p align="right">(<a href="#readme-top">back to top</a>)</p>

# License

No license file is currently included in this repository. All rights are reserved unless a license is added later.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<img src="./image/line-neon.gif" width="100%"><br>
