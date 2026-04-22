import { Soundfont } from "https://unpkg.com/smplr/dist/index.mjs";

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const fileNameDisplay = document.getElementById('file-name');
const instrumentSelect = document.getElementById('instrument-select');
const playBtn = document.getElementById('play-btn');
const stopBtn = document.getElementById('stop-btn');
const exportBtn = document.getElementById('export-btn');
const statusBar = document.getElementById('status-bar');
const visualizer = document.getElementById('visualizer');
const bpmSlider = document.getElementById('bpm-slider');
const bpmVal = document.getElementById('bpm-val');

let currentNotes = [];
let sfInstrument = null;
let ac = null;
let masterGain = null;
let isPlaying = false;
let maxTimeQN = 0;

let isRecording = false;
let recorderNode = null;
let recordedChunksL = [];
let recordedChunksR = [];

for(let i = 0; i < 20; i++) {
    const bar = document.createElement('div');
    bar.className = 'bar';
    visualizer.appendChild(bar);
}

const bars = document.querySelectorAll('.bar');

bpmSlider.addEventListener('input', (e) => {
    bpmVal.textContent = e.target.value;
    if (window.Tone && Tone.Transport) {
        Tone.Transport.bpm.value = parseFloat(e.target.value);
    }
});

dropZone.addEventListener('click', () => fileInput.click());

dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length) {
        handleFile(e.dataTransfer.files[0]);
    }
});

fileInput.addEventListener('change', (e) => {
    if (e.target.files.length) {
        handleFile(e.target.files[0]);
    }
});

function handleFile(file) {
    if (!file.name.toLowerCase().endsWith('.xml') && !file.name.toLowerCase().endsWith('.musicxml')) {
        updateStatus('Please upload a valid .xml or .musicxml file.', true);
        return;
    }
    
    fileNameDisplay.style.display = 'inline-block';
    fileNameDisplay.textContent = file.name;
    updateStatus('Parsing MusicXML...', false);
    
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(e.target.result, "text/xml");
            
            if(xmlDoc.querySelector("parsererror")) {
                throw new Error("Invalid XML file");
            }
            
            currentNotes = parseMusicXML(xmlDoc);
            
            if (currentNotes.length > 0) {
                updateStatus(`Ready to play: ${currentNotes.length} notes found.`, false);
                playBtn.disabled = false;
                exportBtn.disabled = false;
                
                let defaultTempoNode = xmlDoc.querySelector('sound[tempo]');
                if (defaultTempoNode) {
                    let xmlTempo = Math.round(parseFloat(defaultTempoNode.getAttribute('tempo')));
                    xmlTempo = Math.max(50, Math.min(170, xmlTempo));
                    bpmSlider.value = xmlTempo;
                    bpmVal.textContent = xmlTempo;
                    if (window.Tone && Tone.Transport) {
                        Tone.Transport.bpm.value = xmlTempo;
                    }
                }
            } else {
                updateStatus("No notes found in the file.", true);
                playBtn.disabled = true;
                exportBtn.disabled = true;
            }
        } catch (error) {
            console.error(error);
            updateStatus('Error parsing file.', true);
        }
    };
    reader.readAsText(file);
}

function hasWords(measure, matchStr) {
    const wordsNodes = measure.querySelectorAll('direction direction-type words');
    for (let node of wordsNodes) {
        if (node.textContent.toLowerCase().includes(matchStr.toLowerCase())) return true;
    }
    return false;
}

function buildMeasureRoadmap(part) {
    const measures = Array.from(part.querySelectorAll('measure'));
    const markers = { segno: -1, coda: -1 };
    
    measures.forEach((measure, i) => {
        let sound = measure.querySelector('sound');
        if (sound) {
             if (sound.hasAttribute('segno')) markers.segno = i;
             if (sound.hasAttribute('coda')) markers.coda = i;
        }
        if (measure.querySelector('direction-type segno')) markers.segno = i;
        if (measure.querySelector('direction-type coda')) markers.coda = i;
    });

    const unrolledIndices = [];
    let i = 0;
    let playCounts = {}; 
    let hasJumped = false; 
    let lastForwardRepeat = 0;
    let maxIterations = 10000;
    
    while (i < measures.length && maxIterations > 0) {
        maxIterations--;
        const measure = measures[i];
        let skipMeasure = false;
        
        let currentPass = (playCounts[lastForwardRepeat] || 0) + 1;
        
        const ending = measure.querySelector('ending[type="start"]');
        if (ending) {
            let numbers = ending.getAttribute('number');
            if (numbers) {
                let validPasses = numbers.split(',').map(n => parseInt(n.trim()));
                if (!validPasses.includes(currentPass)) {
                    skipMeasure = true;
                }
            }
        }
        
        if (!skipMeasure) {
            unrolledIndices.push(i);
            const sound = measure.querySelector('sound');
            
            let isFine = (sound && sound.getAttribute('fine') === "yes") || hasWords(measure, "fine");
            if (isFine && hasJumped) break;
            
            let isToCoda = (sound && sound.hasAttribute('tocoda')) || hasWords(measure, "to coda");
            if (isToCoda && hasJumped && markers.coda !== -1) {
                i = markers.coda;
                continue; 
            }
            
            const fwdRepeat = measure.querySelector('repeat[direction="forward"]');
            if (fwdRepeat) {
                lastForwardRepeat = i;
                playCounts[lastForwardRepeat] = playCounts[lastForwardRepeat] || 0;
            }
            
            const bwdRepeat = measure.querySelector('repeat[direction="backward"]');
            if (bwdRepeat) {
                let times = bwdRepeat.getAttribute('times');
                let targetCount = times ? parseInt(times) : 2; 
                let currentPasses = playCounts[lastForwardRepeat] || 0;
                
                if (currentPasses < targetCount - 1) {
                    playCounts[lastForwardRepeat] = currentPasses + 1;
                    i = lastForwardRepeat;
                    continue;
                }
            }
            
            if (!hasJumped) {
                let isDacapo = (sound && sound.getAttribute('dacapo') === "yes") || hasWords(measure, "d.c.");
                if (isDacapo) {
                    hasJumped = true;
                    i = 0;
                    continue;
                } 
                
                let isDalsegno = (sound && sound.hasAttribute('dalsegno')) || hasWords(measure, "d.s.");
                if (isDalsegno && markers.segno !== -1) {
                    hasJumped = true;
                    i = markers.segno;
                    continue;
                }
            }
        }
        i++;
    }
    return unrolledIndices;
}

function parseMusicXML(xmlDoc) {
    let notes = [];
    let currentTimeQN = 0;
    maxTimeQN = 0;
    
    const parts = Array.from(xmlDoc.querySelectorAll('part'));
    if (!parts.length) return [];
    
    const unrolledIndices = buildMeasureRoadmap(parts[0]);
    
    parts.forEach(part => {
        currentTimeQN = 0;
        let divisions = 24;
        let previousDurationQN = 0;
        
        const measures = Array.from(part.querySelectorAll('measure'));
        
        unrolledIndices.forEach(idx => {
            if (idx >= measures.length) return;
            const measure = measures[idx];
            
            Array.from(measure.children).forEach(node => {
                if (node.nodeName === 'attributes') {
                    const divNode = node.querySelector('divisions');
                    if (divNode) divisions = parseInt(divNode.textContent);
                } else if (node.nodeName === 'note') {
                    const durationNode = node.querySelector('duration');
                    const durationUnits = durationNode ? parseInt(durationNode.textContent) : 0;
                    const durationQN = durationUnits / divisions;
                    
                    const isChord = node.querySelector('chord') !== null;
                    const isRest = node.querySelector('rest') !== null;
                    
                    let noteStartTimeQN = currentTimeQN;
                    if (isChord) noteStartTimeQN -= previousDurationQN;
                    
                    if (!isRest && durationQN > 0) {
                        const pitchNode = node.querySelector('pitch');
                        if (pitchNode) {
                            const step = pitchNode.querySelector('step').textContent;
                            const octave = pitchNode.querySelector('octave').textContent;
                            const alterNode = pitchNode.querySelector('alter');
                            const alter = alterNode ? parseInt(alterNode.textContent) : 0;
                            
                            let noteName = step;
                            if (alter === 1) noteName += '#';
                            if (alter === -1) noteName += 'b';
                            noteName += octave;
                            
                            notes.push({
                                pitch: noteName,
                                startQN: noteStartTimeQN,
                                durationQN: durationQN
                            });
                            
                            if (noteStartTimeQN + durationQN > maxTimeQN) {
                                maxTimeQN = noteStartTimeQN + durationQN;
                            }
                        }
                    }
                    
                    if (!isChord) {
                        currentTimeQN += durationQN;
                        previousDurationQN = durationQN;
                    }
                } else if (node.nodeName === 'backup') {
                    const durNode = node.querySelector('duration');
                    if (durNode) currentTimeQN -= parseInt(durNode.textContent) / divisions;
                } else if (node.nodeName === 'forward') {
                    const durNode = node.querySelector('duration');
                    if (durNode) currentTimeQN += parseInt(durNode.textContent) / divisions;
                }
            });
        });
    });
    
    notes.sort((a,b) => a.startQN - b.startQN);
    return notes;
}

instrumentSelect.addEventListener('change', async () => {
    if (sfInstrument) {
        sfInstrument.stop();
        sfInstrument = null; 
    }
});

async function prepareAudio() {
    if (!ac) {
        await Tone.start();
        ac = Tone.context.rawContext;
        
        masterGain = ac.createGain();
        masterGain.connect(ac.destination);
    }
    
    if (!sfInstrument) {
        updateStatus('Loading high-quality instrument samples...', false);
        let selected = instrumentSelect.value;
        let sfName = selected;
        if (selected.includes('recorder')) sfName = 'recorder';
        
        try {
            sfInstrument = new Soundfont(ac, { 
                instrument: sfName,
                destination: masterGain
            });
            await sfInstrument.load;
            updateStatus('Instrument loaded.', false);
        } catch(e) {
            console.error("Error loading instrument:", e);
            updateStatus('Failed to load instrument.', true);
            throw e;
        }
    }
}

function triggerVisualizer() {
    bars.forEach(bar => {
        if(Math.random() > 0.5) {
            bar.style.height = `${20 + Math.random() * 40}px`;
            bar.classList.add('active');
            setTimeout(() => {
                bar.style.height = '10px';
                bar.classList.remove('active');
            }, 100);
        }
    });
}

function stopPlaying(aborted = false) {
    Tone.Transport.stop();
    Tone.Transport.cancel(); 
    if (sfInstrument) sfInstrument.stop();
    isPlaying = false;
    
    playBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
    stopBtn.disabled = true;
    
    if (isRecording && aborted) {
        isRecording = false;
        exportBtn.disabled = false;
        playBtn.disabled = false;
        updateStatus('Export aborted automatically.', true);
    } else {
        updateStatus('Stopped.');
    }
    
    bars.forEach(bar => {
        bar.style.height = '10px';
        bar.classList.remove('active');
    });
}

function triggerMasterPlayback() {
    Tone.Transport.cancel();
    Tone.Transport.bpm.value = parseFloat(bpmSlider.value);

    currentNotes.forEach(note => {
        let startTick = note.startQN * Tone.Transport.PPQ;
        Tone.Transport.schedule((time) => {
            let midiNode = Tone.Frequency(note.pitch).toMidi();
            let durSec = Tone.Ticks(note.durationQN * Tone.Transport.PPQ).toSeconds();
            sfInstrument.start({ note: midiNode, time: time, duration: durSec });
            triggerVisualizer();
        }, Math.round(startTick) + "i");
    });
    
    let endTick = maxTimeQN * Tone.Transport.PPQ;
    Tone.Transport.schedule((time) => { 
        if (isRecording) {
            setTimeout(finishMediaExport, 2000); 
        } else {
            stopPlaying(); 
        }
    }, Math.round(endTick) + "i");
    
    Tone.Transport.start();
}

playBtn.addEventListener('click', async () => {
    if (isPlaying) {
        Tone.Transport.pause();
        if (sfInstrument) sfInstrument.stop();
        isPlaying = false;
        playBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
        updateStatus('Paused.');
        return;
    }
    try {
        await prepareAudio();
        
        if (Tone.Transport.state !== 'paused') {
            triggerMasterPlayback();
        } else {
            Tone.Transport.start();
        }
        
        isPlaying = true;
        playBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
        stopBtn.disabled = false;
        updateStatus('Playing...');
    } catch(e) {
        console.error(e);
        updateStatus('Could not play audio due to an error.', true);
    }
});

stopBtn.addEventListener('click', () => stopPlaying(true));

// =========== NATIVE MEDIA RECORDER TO WAV Exporter ===========

let activeMediaRecorder = null;
let activeStreamNode = null;
let mediaChunks = [];

function arraysToWav(buffer, sampleRate) {
    let left = buffer.getChannelData(0);
    let right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;

    let numOfChan = 2;
    let length = left.length * numOfChan * 2 + 44;
    let outBuf = new ArrayBuffer(length);
    let view = new DataView(outBuf);
    let pos = 0;

    function setUint16(data) { view.setUint16(pos, data, true); pos += 2; }
    function setUint32(data) { view.setUint32(pos, data, true); pos += 4; }

    setUint32(0x46464952); // "RIFF"
    setUint32(length - 8); 
    setUint32(0x45564157); // "WAVE"
    setUint32(0x20746d66); // "fmt "
    setUint32(16); 
    setUint16(1); // PCM
    setUint16(numOfChan);
    setUint32(sampleRate);
    setUint32(sampleRate * 2 * numOfChan); 
    setUint16(numOfChan * 2); 
    setUint16(16); // 16-bit
    setUint32(0x61746164); // "data" 
    setUint32(length - pos - 4); 

    let offset = 0;
    while (pos < length) {
        let sampleL = Math.max(-1, Math.min(1, left[offset]));
        sampleL = (0.5 + sampleL < 0 ? sampleL * 32768 : sampleL * 32767) | 0;
        view.setInt16(pos, sampleL, true);
        pos += 2;
        
        let sampleR = Math.max(-1, Math.min(1, right[offset]));
        sampleR = (0.5 + sampleR < 0 ? sampleR * 32768 : sampleR * 32767) | 0;
        view.setInt16(pos, sampleR, true);
        pos += 2;
        
        offset++;
    }

    return new Blob([outBuf], { type: "audio/wav" });
}

exportBtn.addEventListener('click', async () => {
    if (!currentNotes.length) return;
    try {
        await prepareAudio();
        stopPlaying(false);
        
        updateStatus('Exporting... Audio will play natively to correctly lock the timeline.', false);
        exportBtn.disabled = true;
        playBtn.disabled = true;
        
        isRecording = true;
        mediaChunks = [];
        
        activeStreamNode = ac.createMediaStreamDestination();
        masterGain.connect(activeStreamNode);
        
        activeMediaRecorder = new MediaRecorder(activeStreamNode.stream);
        activeMediaRecorder.ondataavailable = e => {
            if (e.data.size > 0) mediaChunks.push(e.data);
        };
        activeMediaRecorder.start();
        
        triggerMasterPlayback();
        isPlaying = true;
        stopBtn.disabled = false;
        playBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
    } catch (e) {
        console.error("Export Launch Error:", e);
        updateStatus('Export failed to launch.', true);
        exportBtn.disabled = false;
        playBtn.disabled = false;
    }
});

function finishMediaExport() {
    isRecording = false;
    stopPlaying(false);
    updateStatus('Processing audio decode into WAV chunk...', false);
    
    if (activeMediaRecorder) {
        activeMediaRecorder.onstop = async () => {
            masterGain.disconnect(activeStreamNode);
            activeStreamNode = null;
            
            try {
                const combinedBlob = new Blob(mediaChunks);
                const arrayBuffer = await combinedBlob.arrayBuffer();
                const audioBuffer = await ac.decodeAudioData(arrayBuffer);
                
                let wavBlob = arraysToWav(audioBuffer, audioBuffer.sampleRate);
                
                const url = URL.createObjectURL(wavBlob);
                const a = document.createElement('a');
                a.style.display = 'none';
                a.href = url;
                let safeName = fileNameDisplay.textContent.replace('.musicxml', '').replace('.xml', '');
                let bpm = parseFloat(bpmSlider.value);
                a.download = `${safeName}_${bpm}bpm.wav`;
                document.body.appendChild(a);
                a.click();
                
                setTimeout(() => { 
                    document.body.removeChild(a); 
                    window.URL.revokeObjectURL(url); 
                }, 1000);
                
                exportBtn.disabled = false;
                playBtn.disabled = false;
                updateStatus('WAV Exported and Downloaded Successfully!', false);
            } catch (err) {
                console.error(err);
                updateStatus('Export conversion failed.', true);
                exportBtn.disabled = false;
                playBtn.disabled = false;
            }
        };
        activeMediaRecorder.stop();
    }
}

function updateStatus(msg, isError = false) {
    statusBar.textContent = msg;
    statusBar.style.color = isError ? 'var(--error)' : 'var(--text-muted)';
}
