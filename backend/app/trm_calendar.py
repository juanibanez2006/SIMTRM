"""Calendar of expected TRM validities, distinct from certified observations.

DOAM-146 (2020), Ley 51/1983, Ley 2578/2026 and Federal Reserve BANK
holidays (not the US federal employees' Friday-observance calendar).
"""

from dataclasses import dataclass
from datetime import date, timedelta
from functools import lru_cache

from app.simulation import SimulationError

VERSION = "trm-calendar-1.1.0"
SOURCES = [
    "https://www.banrep.gov.co/sites/default/files/reglamentacion/archivos/bjd_94_2020.pdf",
    "https://www.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=4954",
    "https://lector.ramajudicial.gov.co/SIDN/NORMATIVA/TEXTOS_COMPLETOS/7_LEYES/"
    "LEYES%202026/Ley%202578%20de%202026.pdf",
    "https://www.federalreserve.gov/aboutthefed/k8.htm",
    "https://www.banrep.gov.co/sites/default/files/reglamentacion/archivos/01892025GE_0.pdf",
]
CONVENTION = (
    "La TRM calculada con operaciones de un día de mercado rige desde el día calendario "
    "siguiente hasta la siguiente vigencia. Se excluyen sábados, domingos, festivos de "
    "Colombia y de los bancos de la Reserva Federal. El sábado, domingo y lunes ordinarios "
    "comparten la vigencia calculada el viernes. No se generan rendimientos por días "
    "repetidos. El calendario futuro es previsto, no una certificación de la SFC; asume "
    "el cierre anual del CUD el 31 de diciembre, siguiendo el precedente publicado de 2025. "
    "No anticipa cierres extraordinarios, fuerza mayor ni cambios normativos posteriores."
)
DAY = timedelta(days=1)


def next_monday(day: date) -> date:
    return day + timedelta(days=(-day.weekday()) % 7)


def easter(year: int) -> date:
    # Gregorian computus (Meeus/Jones/Butcher), integer arithmetic.
    a, b, c = year % 19, year // 100, year % 100
    d, e = b // 4, b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = c // 4, c % 4
    weekday = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * weekday) // 451
    n = h + weekday - 7 * m + 114
    return date(year, n // 31, n % 31 + 1)


@lru_cache(maxsize=128)
def colombia_holidays(year: int, new_july_holiday: bool = True) -> frozenset[date]:
    fixed = [(1, 1), (5, 1), (7, 20), (8, 7), (12, 8), (12, 25)]
    moved = [(1, 6), (3, 19), (6, 29), (8, 15), (10, 12), (11, 1), (11, 11)]
    if year >= 2026 and new_july_holiday:
        moved.append((7, 9))  # Ley 2578, effective June 2026.
    holy = easter(year)
    return frozenset(
        [date(year, month, day) for month, day in fixed]
        + [next_monday(date(year, month, day)) for month, day in moved]
        + [holy - timedelta(days=3), holy - timedelta(days=2)]
        + [next_monday(holy + timedelta(days=n)) for n in (39, 60, 68)]
    )


def nth_weekday(year: int, month: int, weekday: int, nth: int) -> date:
    first = date(year, month, 1)
    return first + timedelta(days=(weekday - first.weekday()) % 7 + 7 * (nth - 1))


@lru_cache(maxsize=128)
def fed_holidays(year: int, juneteenth: bool = True) -> frozenset[date]:
    fixed = [(1, 1), (7, 4), (11, 11), (12, 25)]
    if year >= 2021 and juneteenth:
        fixed.append((6, 19))
    days = [date(year, m, d) for m, d in fixed]
    # Sunday -> Monday; Saturday does NOT close Federal Reserve Banks on Friday.
    days += [d + DAY for d in days if d.weekday() == 6]
    days += [
        nth_weekday(year, 1, 0, 3),
        nth_weekday(year, 2, 0, 3),
        nth_weekday(year, 9, 0, 1),
        nth_weekday(year, 10, 0, 2),
        nth_weekday(year, 11, 3, 4),
    ]
    last_may = date(year, 5, 31)
    days.append(last_may - timedelta(days=last_may.weekday()))
    return frozenset(days)


def market_day(day: date, as_of: date | None = None) -> bool:
    return (
        day.weekday() < 5
        and day not in colombia_holidays(day.year, as_of is None or as_of >= date(2026, 6, 2))
        and day not in fed_holidays(day.year, as_of is None or as_of >= date(2021, 6, 17))
        and ((day.month, day.day) != (12, 31) or (as_of is not None and as_of < date(2025, 12, 31)))
    )


@dataclass(frozen=True)
class Validity:
    start: date
    end: date


def future_validities(
    initial_until: date, target: date, as_of: date | None = None
) -> list[Validity]:
    """Anchor to certified valid_to, then advance by expected publication transitions."""
    if not 1991 <= initial_until.year <= 2030 or target.year > 2030:
        raise SimulationError("El calendario de proyección admite fechas entre 1991 y 2030")
    if target > initial_until + timedelta(days=730):
        raise SimulationError("La fecha supera el límite de dos años calendario de proyección")
    result, start = [], initial_until + DAY
    while start <= target:
        # A new validity starts the day AFTER the next common market day.
        following_market = start
        while not market_day(following_market, as_of):
            following_market += DAY
        result.append(Validity(start, following_market))
        start = following_market + DAY
        if len(result) > 365:
            raise SimulationError("La fecha requiere más de 365 transiciones; reduzca el horizonte")
    return result
