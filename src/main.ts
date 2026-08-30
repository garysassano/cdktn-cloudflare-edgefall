import { App } from "cdktn";
import { EdgefallStack } from "./stacks/edgefall-stack.js";

const app = new App();

new EdgefallStack(app, "cdktn-cloudflare-edgefall-dev");

app.synth();
