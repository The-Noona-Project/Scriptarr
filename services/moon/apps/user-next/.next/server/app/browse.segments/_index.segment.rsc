1:"$Sreact.fragment"
3:I[45235,["/_next/static/chunks/0_x1rgropa081.js","/_next/static/chunks/13f9-~q5owr2~.js","/_next/static/chunks/0kkd4gdf~bt~3.js","/_next/static/chunks/009txz~8o8cj9.js"],"default"]
4:I[32901,["/_next/static/chunks/0_x1rgropa081.js","/_next/static/chunks/13f9-~q5owr2~.js","/_next/static/chunks/0kkd4gdf~bt~3.js","/_next/static/chunks/009txz~8o8cj9.js"],"default"]
5:I[39756,["/_next/static/chunks/0_x1rgropa081.js","/_next/static/chunks/13f9-~q5owr2~.js","/_next/static/chunks/0kkd4gdf~bt~3.js","/_next/static/chunks/009txz~8o8cj9.js"],"default"]
6:I[37457,["/_next/static/chunks/0_x1rgropa081.js","/_next/static/chunks/13f9-~q5owr2~.js","/_next/static/chunks/0kkd4gdf~bt~3.js","/_next/static/chunks/009txz~8o8cj9.js"],"default"]
:HL["/_next/static/chunks/0jvy-.pru-m8v.css","style"]
:HL["/_next/static/chunks/0-_gmbhliqqci.css","style"]
:HL["/_next/static/chunks/0u4zp0_23pm9n.css","style"]
:HL["/_next/static/chunks/14y~22ldk6tm1.css","style"]
:HL["/_next/static/chunks/0zsgpgt5018hw.css","style"]
2:T7b7,
          (function() {
            try {
              const root = document.documentElement;
              
              // Set defaults from config
              const config = {"theme":"system","brand":"orange","accent":"indigo","neutral":"slate","solid":"contrast","solid-style":"flat","border":"rounded","surface":"translucent","transition":"all","scaling":"100","viz-style":"categorical"};
              
              // Apply default values
              Object.entries(config).forEach(([key, value]) => {
                root.setAttribute('data-' + key, value);
              });
              
              // Resolve theme
              const resolveTheme = (themeValue) => {
                if (!themeValue || themeValue === 'system') {
                  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
                }
                return themeValue;
              };
              
              // Apply saved theme or use config default
              const savedTheme = localStorage.getItem('data-theme');
              // Only override with system preference if explicitly set to 'system'
              const resolvedTheme = savedTheme ? resolveTheme(savedTheme) : config.theme === 'system' ? resolveTheme(window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : config.theme;
              root.setAttribute('data-theme', resolvedTheme);
              
              // Apply any saved style overrides
              const styleKeys = Object.keys(config);
              styleKeys.forEach(key => {
                const value = localStorage.getItem('data-' + key);
                if (value) {
                  root.setAttribute('data-' + key, value);
                }
              });
            } catch (e) {
              console.error('Failed to initialize theme:', e);
              document.documentElement.setAttribute('data-theme', 'dark');
            }
          })();
        0:{"rsc":["$","$1","c",{"children":[[["$","link","0",{"rel":"stylesheet","href":"/_next/static/chunks/0jvy-.pru-m8v.css","precedence":"next"}],["$","link","1",{"rel":"stylesheet","href":"/_next/static/chunks/0-_gmbhliqqci.css","precedence":"next"}],["$","link","2",{"rel":"stylesheet","href":"/_next/static/chunks/0u4zp0_23pm9n.css","precedence":"next"}],["$","link","3",{"rel":"stylesheet","href":"/_next/static/chunks/14y~22ldk6tm1.css","precedence":"next"}],["$","link","4",{"rel":"stylesheet","href":"/_next/static/chunks/0zsgpgt5018hw.css","precedence":"next"}],["$","script","script-0",{"src":"/_next/static/chunks/0_x1rgropa081.js","async":true}],["$","script","script-1",{"src":"/_next/static/chunks/13f9-~q5owr2~.js","async":true}],["$","script","script-2",{"src":"/_next/static/chunks/0kkd4gdf~bt~3.js","async":true}],["$","script","script-3",{"src":"/_next/static/chunks/009txz~8o8cj9.js","async":true}]],["$","html",null,{"lang":"en","suppressHydrationWarning":true,"children":["$","body",null,{"children":[["$","script",null,{"id":"theme-init","dangerouslySetInnerHTML":{"__html":"$2"}}],["$","$L3",null,{"children":["$","$L4",null,{"children":["$","$L5",null,{"parallelRouterKey":"children","template":["$","$L6",null,{}],"notFound":[[["$","title",null,{"children":"404: This page could not be found."}],["$","div",null,{"style":{"fontFamily":"system-ui,\"Segoe UI\",Roboto,Helvetica,Arial,sans-serif,\"Apple Color Emoji\",\"Segoe UI Emoji\"","height":"100vh","textAlign":"center","display":"flex","flexDirection":"column","alignItems":"center","justifyContent":"center"},"children":["$","div",null,{"children":[["$","style",null,{"dangerouslySetInnerHTML":{"__html":"body{color:#000;background:#fff;margin:0}.next-error-h1{border-right:1px solid rgba(0,0,0,.3)}@media (prefers-color-scheme:dark){body{color:#fff;background:#000}.next-error-h1{border-right:1px solid rgba(255,255,255,.3)}}"}}],"$L7","$L8"]}]}]],[]]}]}]}]]}]}]]}],"isPartial":false,"staleTime":300,"varyParams":null,"buildId":"ZcMvJjV5n4cZBQHnG4MMx"}
7:["$","h1",null,{"className":"next-error-h1","style":{"display":"inline-block","margin":"0 20px 0 0","padding":"0 23px 0 0","fontSize":24,"fontWeight":500,"verticalAlign":"top","lineHeight":"49px"},"children":404}]
8:["$","div",null,{"style":{"display":"inline-block"},"children":["$","h2",null,{"style":{"fontSize":14,"fontWeight":400,"lineHeight":"49px","margin":0},"children":"This page could not be found."}]}]
