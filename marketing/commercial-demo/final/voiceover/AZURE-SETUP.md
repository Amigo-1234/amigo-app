# Azure AI Speech setup for the Abeo narration

**Goal:** a paid-tier (Standard S0) Speech resource, so the narration has commercial output rights. Render cost: 624 characters, about one US cent at Microsoft's usual neural rate. Check the live rate in the [pricing page](https://azure.microsoft.com/en-us/pricing/details/cognitive-services/speech-services/) or the Azure pricing calculator.

**Why not the free tier (F0):** it gives 0.5 million neural characters a month, but the output-use clause quoted for prebuilt neural voices is "for customers of the paid tier TTS Service only". Microsoft Q&A answers conflict on this, so don't rely on F0 for a commercial.

## Steps (about 10 minutes, all in your browser)

1. **Sign in** at https://portal.azure.com with the Microsoft account you want billed.
2. **Subscription:** if you have none, create **Pay-As-You-Go**. A card is needed, but nothing is charged until you use a paid service. A new "Azure free account" also works: its starting credit pays for S0 usage at paid-tier prices.
3. **Spending guard:** Cost Management → Budgets → create a budget of **US$1** with an email alert at 50%.
4. **Create the Speech resource:**
   - Go to Create a resource → search **"Speech"** → **Speech service** (Azure AI services) → Create.
   - Resource group: new, `amigo-commercial`.
   - Region: e.g. **UK South** or **West Europe**.
   - Name: e.g. `amigo-commercial-speech`.
   - **Pricing tier: Standard S0** (not Free F0).
   - Review + create.
5. **Copy the key:** open the resource → **Keys and Endpoint**. Copy **KEY 1** and note the **Location/Region** code, e.g. `uksouth`.
6. **Save it privately.** In a text editor, create `/Users/mac/amigo-world/secrets/azure-speech.env` with exactly these two lines:
   ```
   AZURE_SPEECH_KEY=paste-key-1-here
   AZURE_SPEECH_REGION=uksouth
   ```
   The `secrets/` folder is git-ignored. **Don't paste the key into chat.**
7. **Tell me it's saved.** I'll run a dry check (no charge), then, with your OK, the paid render: `node project/azure-tts.mjs --render`. That's 17 requests and 624 characters. Then I rebuild and verify timing and levels.
8. **Afterwards (optional):** regenerate the key (Keys and Endpoint → Regenerate Key 1), or delete the resource group if you won't render again.

## Conditions to note

- **Disclosure:** Microsoft's text-to-speech code of conduct expects synthetic voices to be disclosed where people could be misled. A line in the video description or credits ("Narration: Microsoft Azure AI text-to-speech") covers this without touching the locked edit.
- **Your script, your rights:** the narration text is ours. The output must not be used to train or build a competing TTS service.
- **Records:** `voiceover/azure-abeo/PROVENANCE.json` (written at render time) stores the voice, settings, region, date and Azure request IDs, as evidence of a paid-tier render.
