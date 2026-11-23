"""Anonymous browser ownership. Local mode keeps its existing shared history."""

from contextvars import ContextVar

visitor: ContextVar[str | None] = ContextVar("simtrm_visitor", default=None)


def own_experiment(connection, experiment_id: str) -> None:
    owner = visitor.get()
    if owner is not None:
        connection.execute(
            "INSERT INTO experiment_owners(experiment_id, visitor) VALUES(?,?)",
            (experiment_id, owner),
        )


def ownership_filter(alias: str) -> tuple[str, list]:
    owner = visitor.get()
    if owner is None:
        return "", []
    return (
        "EXISTS(SELECT 1 FROM experiment_owners access "
        f"WHERE access.experiment_id={alias}.id AND access.visitor=?)",
        [owner],
    )
