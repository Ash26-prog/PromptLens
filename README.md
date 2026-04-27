1. Main idea/theme-

PromptLens is a Chrome extension that enhances user prompts in real-time across AI platforms like ChatGPT, Gemini,Claude etc. It transforms low-quality prompts into optimized, high-quality prompts while explaining the improvements, helping users learn prompt engineering via explaination.


2.Features-

a)One-click prompt refinement  
b) AI-powered optimization using Google Gemini(Groq for quick testing)
c) Prompt quality scoring  
d) Clear explanation for improvements  
e) Real-time feedback based on 10 modern prompting principles 
f) Secure authentication using Firebase  

3. Working-

a) User enters a prompt in an AI tool  
b) PromptLens analyzes the input  
c) Applies structured prompt engineering principles and refines it with the help of it's own engine 
d) Following this, it sends request to Gemini API  
e) Output-

   e.1) Refined prompt  
   e.2) Quality score  
   e.3)Explanation  

4. TechStack-

a) Frontend-
Chrome Extension-JavaScript, HTML, CSS

b) Backend-
Firebase (Authentication & Firestore for storing user feedback)

c) AI Layer-
Google Gemini API

d) Integration-
Chrome Identity API  
REST APIs  

5. Security Notes-
   
a) Firebase API key is restricted to required APIs only  
b)Firestore access is controlled via authentication rules  
c) OAuth Client ID is restricted to required scopes in Google Cloud Console. API key is user-supplied and stored locally in chrome.storage (prototype trade-off,a production build would route through a backend proxy).
d) Current version uses broad host permissions for prototype to cover across various AI platforms. The production release would support specific domains only .


6. Installation process-

a) Clone the repository
```bash
git clone https://github.com/Ash26-prog/PromptLens.git
cd PromptLens

b) Load extension in Chrome
b.1) Go to chrome://extensions/
b.2) Enable Developer Mode
b.3) Click Load unpacked
b.4) Select the project folder
b.5) Pin the extension
b.6) Add your Gemini API key

7. Usage-
7.1) Open any AI platform (ChatGPT, Gemini, etc.)
7.2) Type a prompt
7.3) Select entire text using- Ctrl+A 
7.4) Use ctrl+shift+M to turn on the extension(above the typing bar, all the features should be visible)
7.5) Click explain using PromptLens
7.6) Improved prompt

8. Future scope-
8.1) Personalized prompt suggestions
8.2) Multi-language support
8.3) Integration with IDEs
8.4) Advanced analytics and user insights
8.5) Support for multiple AI models
8.6) Compatibility with multiple browsers and mobile app

9. Main objective-
To bridge the gap between AI capability and user skill by making prompt engineering intuitive, accessible, and learnable through real-time usage.

10.Author-
Ash M
Kaush V
GitHub: https://github.com/Ash26-prog

11.License-
This project is for educational and prototype purposes.
