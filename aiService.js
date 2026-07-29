async function evaluateDiffWithAI(diffText, recentMilestones) {
  const systemPrompt = `You are a strict engineering assistant. You analyze GitHub code diffs. You must return a valid JSON object. You have two choices:
Choice 1: If the code logically belongs to one of the recent milestones, return: {"action": "merge", "milestone_id": "<id>"}
Choice 2: If it is a new feature, return: {"action": "create", "milestone_title": "<short title>", "complexity_score": <1-10>, "extracted_skills": ["skill1", "skill2"]}
Do not include any markdown formatting or extra text. Only return JSON.`;

  const userPrompt = `Diff:\n${diffText}\n\nRecent milestones:\n${JSON.stringify(recentMilestones)}`;

  try {
    const response = await fetch(process.env.AI_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.AI_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://shadow-portfolio.com',
        'X-Title': 'Shadow Portfolio',
      },
      body: JSON.stringify({
        model: process.env.AI_MODEL,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });

    if (!response.ok) {
      console.error('AI API error:', response.status, response.statusText);
      return null;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      console.error('AI response missing content');
      return null;
    }

    return JSON.parse(content);
  } catch (err) {
    console.error('AI service error:', err);
    return null;
  }
}

module.exports = { evaluateDiffWithAI };
