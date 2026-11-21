// People and pets as stacks: a fallback figure only. stack-chars.js (loaded
// after the model files) replaces S.peopleItems with the full characters, pets
// and chairs, and adds S.personAt / S.personTop.
(function () {
    'use strict';
    var S = window.VOStack = window.VOStack || {};

    function simpleFigure(body, skin, hair) {
        var m = S.model(-8, -5, 8, 5, 52, 0);
        m.box(-6, -3, 0, 5, 5, 18, '#37474f'); m.box(1, -3, 0, 5, 5, 18, '#37474f');   // legs
        m.rbox(-8, -4, 18, 16, 8, 16, 2, body);                                         // torso
        m.rbox(-7, -6, 34, 14, 12, 14, 3, skin);                                        // head
        m.rbox(-7, -6, 44, 14, 12, 6, 2, hair);
        return m;
    }

    S.peopleItems = S.peopleItems || function (out, idFor, now, runLegacy) {
        var list = (agents || []).concat(typeof officePets !== 'undefined' ? officePets : [], typeof _lifeExtras !== 'undefined' ? _lifeExtras : []);
        for (var i = 0; i < list.length; i++) {
            var a = list[i];
            if (!a || !isFinite(a.x) || !isFinite(a.y)) continue;
            if (runLegacy && typeof a.draw === 'function') runLegacy(a);
            var app = typeof a.getAppearance === 'function' ? a.getAppearance() : {};
            var key = 'p|' + (a.color || '') + (app.skinTone || '') + (app.hairColor || '');
            var mesh = S.mesh(key, function () { return simpleFigure(a.color || '#5c6bc0', app.skinTone || '#ffcc80', app.hairColor || '#333'); }, 'dynamic');
            out.push({ mesh: mesh, x: a.x, y: a.y, z: 0, turn: 0, id: idFor('agent', i, a) });
        }
    };
})();
