---
id: it-backup-restore
title: Kopie zapasowe i odtwarzanie danych
department: IT Operations
access: it
owner: Krzysztof Malinowski
owner_role: Kierownik IT Operations
version: 1
effective_date: 2025-12-01
supersedes: null
language: pl
---

# Kopie zapasowe i odtwarzanie danych

Dokument opisuje harmonogram kopii zapasowych oraz procedurę odtwarzania danych firmowych.

## Harmonogram

Kopie przyrostowe wykonujemy codziennie o 2:00. Kopię pełną wykonujemy co tydzień w niedzielę o 1:00. Kopie bazy AtlasWMS są dodatkowo replikowane w trybie ciągłym do węzła zapasowego.

## Retencja

Kopie dzienne przechowujemy 35 dni, kopie miesięczne 12 miesięcy, a kopie roczne 7 lat. Dłuższa retencja dotyczy danych finansowych, które muszą być dostępne dla celów podatkowych. Kopie kończące retencję są usuwane automatycznie.

## Lokalizacja kopii

Kopie są szyfrowane i przechowywane w dwóch miejscach: lokalnej macierzy w serwerowni w Krakowie oraz w drugim centrum danych w Polsce. Dostęp do klucza szyfrującego ma tylko dwóch administratorów.

## Odtwarzanie

Prośbę o odtworzenie pliku lub folderu składa się w Atlas Helpdesk. Odtworzenie pojedynczych plików wykonujemy w ciągu 4 godzin roboczych, a pełne odtworzenie systemu w ciągu 24 godzin. Odtwarzanie danych HR lub finansowych wymaga zgody właściciela danych.

## Testy odtwarzania

Co kwartał IT wykonuje test odtworzenia losowo wybranej kopii i dokumentuje wynik. Nieudany test jest incydentem P3 i musi zostać naprawiony w ciągu 5 dni roboczych.
