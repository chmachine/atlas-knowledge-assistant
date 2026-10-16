---
id: it-runbook-wms-outage
title: Runbook: awaria systemu AtlasWMS
department: IT Operations
access: it
owner: Krzysztof Malinowski
owner_role: Kierownik IT Operations
version: 1
effective_date: 2026-02-15
supersedes: null
language: pl
---

# Runbook: awaria systemu AtlasWMS

Procedura reagowania na niedostępność systemu zarządzania magazynem AtlasWMS. System obsługuje przyjęcia, kompletację i wydania w magazynach w Krakowie i we Wrocławiu.

## Wykrycie i klasyfikacja

Awarię wykrywa monitoring: alert WMS-HEALTH w kolorze czerwonym przez 5 minut albo zgłoszenie kierownika zmiany. Każda niedostępność AtlasWMS trwająca dłużej niż 5 minut jest incydentem priorytetu P1. Dyżurny inżynier zakłada zgłoszenie P1 w Atlas Helpdesk i przejmuje rolę koordynatora incydentu.

## Przełączenie na węzeł zapasowy

Pierwszym krokiem naprawczym jest przełączenie na węzeł zapasowy wms-b. Przełączenie trwa około 10 minut i wykonuje się je poleceniem failover z konsoli administracyjnej. Przed przełączeniem koordynator sprawdza, że replika bazy danych jest aktualna, a opóźnienie replikacji nie przekracza 5 minut.

## Tryb awaryjny na magazynie

Jeśli system nie wróci do działania w ciągu 15 minut, kierownicy zmiany przechodzą na ręczną kompletację z papierowych list kompletacyjnych. Lista jest generowana automatycznie co godzinę jako zrzut zleceń (tzw. paper snapshot) i drukowana na drukarkach w strefach A-D. Po przywróceniu systemu operacje nadrabiają zaległe wpisy w ciągu 2 godzin.

## Komunikacja

Koordynator informuje dyrektora operacyjnego i kierowników zmian co 30 minut, aż do zakończenia incydentu. Komunikaty trafiają do kanału Teams "WMS-Incydenty". Klientów o opóźnieniach powiadamia dział obsługi klienta.

## Cele odtworzenia

Docelowy czas odtworzenia (RTO) dla AtlasWMS wynosi 2 godziny, a dopuszczalna utrata danych (RPO) 5 minut. Po zakończeniu incydentu zespół IT przeprowadza przegląd poawaryjny w ciągu 3 dni roboczych.
