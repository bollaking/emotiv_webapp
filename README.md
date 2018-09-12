Instructions to get webapp talking to Cortex

install browserify globally:

npm install -g browserify

Wrap code so that the nodejs can be run in a browser by running

browserify index.js -o webapp.js

Point your browser at: "file://.../webapp_template_basic/index.html"

Make sure you have a headset connected and that you are logged out of Cortex in CortexUI