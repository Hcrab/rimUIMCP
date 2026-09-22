"""Same wire, selectors and errors as the TypeScript SDK. No game rules live here."""
import asyncio
import contextvars
import json
import os
from pathlib import Path
import urllib.request
import uuid


class RimError(RuntimeError):
    def __init__(self, result):
        self.result = result
        self.code = result.get("error", {}).get("code", "TRANSPORT_ERROR")
        super().__init__(result.get("error", {}).get("message", self.code))


class Locator:
    def __init__(self, game, selector):
        self.game, self.selector = game, selector

    def filter(self, **selector):
        return Locator(self.game, {**self.selector, **selector})

    async def read(self):
        return await self.game.call("ui.read", selector=self.selector)

    async def input(self, action, **args):
        return await self.game.call("ui.input", selector=self.selector, action=action, **args)

    async def click(self, button="left", modifiers=None):
        return await self.input("click", button=button, modifiers=modifiers)

    async def press(self, key, modifiers=None):
        return await self.input("press", key=key, modifiers=modifiers)

    async def hover(self):
        return await self.input("hover")

    def nth(self, index):
        return self.filter(nth=index)

    async def activate(self):
        return await self.click()

    async def fill(self, text):
        return await self.input("fill", text=text)

    async def set_checked(self, value):
        return await self.input("setChecked", value=value)

    async def set_value(self, value):
        return await self.input("setValue", value=value)

    async def scroll(self, **args):
        return await self.input("scroll", **args)


class Namespace:
    def __init__(self, game, name):
        self.game, self.name = game, name

    def __getattr__(self, method):
        aliases = {"next_frame": "nextFrame", "run_until": "runUntil"}
        async def invoke(**args):
            return await self.game.call(self.name + "." + aliases.get(method, method), **args)
        return invoke

    def locator(self, **selector):
        return Locator(self.game, selector)

    def action(self, action_id):
        return Locator(self.game, {"actionId": action_id})


class Game:
    def __init__(self, config):
        self.config = config
        self.script_id = os.environ.get("RIMUIMCP_SCRIPT_ID", str(uuid.uuid4()))
        self._sequence = contextvars.ContextVar("rimuimcp_sequence", default=None)
        for name in ("state", "ui", "runtime", "events", "scripts", "map", "agent"):
            setattr(self, name, Namespace(self, name))

    async def call(self, method, args=None, *, timeout_ms=30000, request_id=None, **kwargs):
        request_id = request_id or str(uuid.uuid4())
        body = json.dumps({"method": method, "args": {**(args or {}), **kwargs}, "requestId": request_id,
                           "scriptId": self.script_id, "sequenceToken": self._sequence.get(), "timeoutMs": timeout_ms}).encode()
        def send():
            request = urllib.request.Request(self.config["url"] + "/call", data=body,
                headers={"Content-Type": "application/json", "Authorization": "Bearer " + self.config["token"]})
            try:
                with urllib.request.urlopen(request, timeout=(timeout_ms + 10000) / 1000) as response:
                    result = json.load(response)
            except urllib.error.HTTPError as error:
                result = json.load(error)
            if not result.get("success"):
                raise RimError(result)
            return result
        return await asyncio.to_thread(send)

    def sequence(self):
        return Sequence(self)


class Sequence:
    def __init__(self, game):
        self.game = game
        self.token = None

    async def __aenter__(self):
        if self.game._sequence.get() is None:
            result = await self.game.call("session.sequence.begin")
            self.token = self.game._sequence.set(result["data"]["token"])
        return self.game

    async def __aexit__(self, exc_type, exc, traceback):
        if self.token is not None:
            try:
                await self.game.call("session.sequence.end", token=self.game._sequence.get())
            finally:
                self.game._sequence.reset(self.token)


async def connect(config=None):
    if not isinstance(config, dict):
        file = Path(config or os.environ.get("RIMUIMCP_CONFIG", Path(__file__).resolve().parents[3] / "work/runtime.json"))
        config = json.loads(file.read_text(encoding="utf-8-sig"))
    game = Game(config)
    await game.call("session.status")
    return game
