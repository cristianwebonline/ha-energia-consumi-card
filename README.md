# Energia Consumi Card

Card consumi interattiva per Home Assistant. Gira interamente nel browser e legge i
dati dalle **statistiche di HA** (`recorder`), quindi funziona anche se il server
esterno è spento.

- Selettore **giorni** con evidenza del giorno **record** 👑 (lampeggia)
- Grafico **consumo per ora** colorato (verde/giallo/rosso)
- **Tocca un'ora** → popup con la classifica di quale elettrodomestico ha consumato di più
- **Classifica elettrodomestici** del giorno
- **Costo orientativo in €** accanto ai kWh
- Chip "Giorno record" cliccabile (interruttore: vai al record / torna a oggi)

## Uso

```yaml
type: custom:energia-consumi-card
title: Consumi di casa
days_back: 8          # 7 / 14 / 30
open_on: today        # today | record
prezzo_kwh: 0.30      # €/kWh (costo orientativo)
soglia_media: 33      # % barra gialla
soglia_alta: 66       # % barra rossa
lampeggio_record: true
```

Gli elettrodomestici mostrati sono quelli configurati in **Impostazioni → Cruscotti →
Energia**. La card si adegua da sola.
