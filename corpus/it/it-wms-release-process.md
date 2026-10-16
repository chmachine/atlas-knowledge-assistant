---
id: it-wms-release-process
title: WMS release and change management process
department: IT Operations
access: it
owner: Krzysztof Malinowski
owner_role: Head of IT Operations
version: 1
effective_date: 2026-03-01
supersedes: null
language: en
---

# WMS release and change management process

This process governs how changes to AtlasWMS and its integrations reach production. Its goal is to avoid disruption in the warehouses.

## Release windows

Standard releases go live only on Tuesdays and Thursdays between 19:00 and 21:00, after the afternoon shift peak. Releases outside these windows are treated as emergency changes.

## Freeze period

A change freeze applies every year from 15 November to 5 January because of the peak season. During the freeze only emergency fixes are allowed, and each one needs approval from both the Head of IT Operations and the Operations Director.

## Change Advisory Board

The Change Advisory Board (CAB) meets every Thursday at 10:00. A change must be submitted by Tuesday 16:00 to be discussed in that week's meeting. Every submission includes a risk assessment, a test report and a rollback plan.

## Testing and approval

Each release is tested in the staging environment, which mirrors production data structures. Business owners from the Kraków and Wrocław warehouses sign off acceptance tests. Releases without a signed acceptance test are rejected by the CAB.

## Rollback

A smoke test runs right after deployment. If it fails, the release manager decides within 30 minutes whether to roll back, and the default decision is to roll back. The rollback plan must have been rehearsed in staging.
