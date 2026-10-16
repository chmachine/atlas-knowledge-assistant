---
id: it-runbook-vpn
title: Runbook: problemy z VPN (Atlas Secure Access)
department: IT Operations
access: it
owner: Krzysztof Malinowski
owner_role: Kierownik IT Operations
version: 1
effective_date: 2025-10-01
supersedes: null
language: pl
---

# Runbook: problemy z VPN (Atlas Secure Access)

Diagnostyka i naprawa typowych problemów z klientem VPN Atlas Secure Access. Dotyczy laptopów służbowych pracowników biurowych.

## Wymagania

Połączenie wymaga ważnego certyfikatu urządzenia oraz weryfikacji dwuskładnikowej w aplikacji uwierzytelniającej. Certyfikat jest ważny 12 miesięcy. Można go odnowić samodzielnie w portalu Atlas Self-Service nie wcześniej niż 30 dni przed wygaśnięciem.

## Najczęstsze błędy

Błąd AS-403 oznacza wygasły lub brakujący certyfikat. Rozwiązaniem jest odnowienie certyfikatu w portalu. Błąd AS-512 oznacza brak odpowiedzi serwera uwierzytelniania, a pierwszą czynnością jest sprawdzenie statusu usługi w panelu monitoringu. Błąd AS-701 oznacza niezgodność czasu na urządzeniu, więc należy włączyć automatyczną synchronizację czasu.

## Sieci hotelowe i publiczne

W sieciach, które blokują ruch UDP, klient automatycznie przełącza się na tryb zapasowy TCP na porcie 443, co może obniżyć szybkość. Jeśli połączenie mimo to nie działa, pracownik powinien użyć hotspotu z telefonu służbowego.

## Tunelowanie

Dzielone tunelowanie (split tunneling) jest wyłączone: cały ruch ze służbowego laptopa przechodzi przez sieć Atlas. Wyjątki wymagają zgody Inspektora Bezpieczeństwa Informacji.

## Eskalacja

Jeśli problemu nie da się rozwiązać w ciągu 30 minut, wsparcie pierwszej linii eskaluje zgłoszenie do administratora sieci. Awaria wpływająca na ponad 10 użytkowników jest klasyfikowana jako P2.
