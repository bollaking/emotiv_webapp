Instructions to get webapp talking to Cortex

install browserify globally:

npm install -g browserify

Go to emotiv.com and create a Cortex App, note your client_id and secret.
Add the client_id and secret to index.js (search for "client_id" to find
the location).

Wrap code so that the nodejs can be run in a browser by running

browserify index.js -o webapp.js

Point your browser at: "file://.../webapp_template_basic/index.html"

Before running:
* Make sure you have a headset connected and 
* in CortexUI check that you are logged out of Cortex

On the page there are input fields to add your emotiv_id and password and
buttons to start and stop an EEG session as well as buttons to send start and 
stop markers (a stop marker is sent as the negative of the start value).

Note: if the start and stop markers are not correctly balanced, then there can 
be problems sending the markers. Although you can send as many start markers.