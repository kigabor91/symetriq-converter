import { convert } from "./convert.js";

async function main() {
    console.log("SymetrIQ Converter");
    await convert();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
